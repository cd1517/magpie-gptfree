/**
 * Magpie provider connection for the local GPTFree token pool.
 *
 * Each valid vault account is synchronized as its own Magpie plugin account
 * entry (`gptfree-pool` for the first/legacy slot and `gptfree-pool#s<hash>`
 * for additional accounts) with a deterministic masked display label and slot
 * tag (`poolSlot`). Magpie's `whoOf()` resolves cleanly to that masked label
 * instead of falling back to `API key …l-v1` or collapsing similar emails.
 *
 * Never save owner credentials, JWTs, OAuth refresh tokens, or raw email
 * addresses in Magpie's plugin-auth store or in the slot map file; secrets
 * stay strictly in the encrypted local vault.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { safeAccountName } from "./credentials.mjs";
import { listPool, poolDir } from "./pool-vault.mjs";

export const POOL_PROVIDER = "gptfree-pool";
export const POOL_MARKER = "gptfree-local-pool-v1";
const SLOTS_FILE = "magpie-slots.json";
const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;

export function isPoolRecord(item) {
  return typeof item?.email === "string" && item.email.trim().includes("@") &&
    typeof item?.accessToken === "string" && item.accessToken.length > 0 &&
    typeof item?.password === "string" &&
    typeof item?.totp === "string";
}

export function normalizePoolEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function accountSlotTag(email) {
  const norm = normalizePoolEmail(email);
  return "s" + createHash("sha256").update(norm).digest("hex").slice(0, 10);
}

export function formatAccountSlotLabel(email) {
  const norm = normalizePoolEmail(email);
  if (!norm || !norm.includes("@")) return "GPTFree account";
  const tag = accountSlotTag(norm);
  return `${safeAccountName(norm)} · ${tag.slice(1, 9)}`;
}

export function countValidPoolAccounts(rows) {
  return Array.isArray(rows) ? rows.filter(isPoolRecord).length : 0;
}

export function poolHasAccounts(rows) {
  return countValidPoolAccounts(rows) > 0;
}

export function formatPoolAccountLabel(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  return n > 1 ? `GPTFree 号池 (${n} 个账号)` : "GPTFree local pool";
}

export function buildSlotAuthBody(email) {
  const label = formatAccountSlotLabel(email);
  const poolSlot = accountSlotTag(email);
  return {
    type: "api",
    key: POOL_MARKER,
    accountId: label,
    metadata: {
      email: label,
      poolSlot,
    },
  };
}

function isValidPoolAuthKey(key) {
  return typeof key === "string" &&
    (key === POOL_PROVIDER || key.startsWith(POOL_PROVIDER + "#")) &&
    key.length <= 96;
}

/**
 * Synchronize Magpie's per-account plugin auth entries with the encrypted vault.
 * This does not imply that any token has passed online validation: Magpie's
 * provider.models and the request adapter still verify upstream access.
 */
export function createPoolConnector(client, {
  poolRead = listPool,
  getActiveKey = null,
  slotsFile = undefined,
} = {}) {
  if (typeof client?.auth?.set !== "function" ||
      typeof client?.auth?.remove !== "function")
    throw new Error("Magpie's host does not support automatic provider registration");

  const resolvedSlotsFile = slotsFile === false ? null :
    slotsFile !== undefined ? slotsFile :
    poolRead === listPool ? join(poolDir(), SLOTS_FILE) : null;

  // Capture an empty AsyncLocalStorage context at connector initialization
  // time so background batch callbacks running after authorize() still call
  // client.auth.set({ path: { id: "gptfree-pool" } }) without Magpie's
  // keyFor() hijacking it to a different account's active sign-in key.
  const outsideScope = typeof AsyncLocalStorage?.snapshot === "function"
    ? AsyncLocalStorage.snapshot()
    : (fn) => fn();

  const slotMap = new Map();
  let slotsLoaded = false;
  const pendingClaims = new Map();
  let deferredBareClean = false;
  let queued = Promise.resolve();

  const runOutside = (fn) => outsideScope(fn);

  async function loadSlots() {
    if (slotsLoaded || !resolvedSlotsFile) {
      slotsLoaded = true;
      return;
    }
    slotsLoaded = true;
    try {
      const raw = await readFile(resolvedSlotsFile, "utf8");
      const parsed = JSON.parse(raw);
      const entries = parsed?.slots && typeof parsed.slots === "object" ? Object.entries(parsed.slots) : [];
      const seenKeys = new Set();
      for (const [slot, key] of entries) {
        if (!SLOT_TAG_RE.test(slot) || !isValidPoolAuthKey(key) || seenKeys.has(key)) continue;
        seenKeys.add(key);
        slotMap.set(slot, key);
      }
      if (parsed?.deferredBareClean === true) deferredBareClean = true;
    } catch {
      // Missing or invalid state file: rebuilt cleanly from the vault on sync.
    }
  }

  async function persistSlots() {
    if (!resolvedSlotsFile) return;
    const parent = join(resolvedSlotsFile, "..");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const tmp = `${resolvedSlotsFile}.${randomBytes(6).toString("hex")}.tmp`;
    const payload = JSON.stringify({
      version: 1,
      deferredBareClean,
      slots: Object.fromEntries(slotMap),
    }, null, 2);
    try {
      await writeFile(tmp, payload, { mode: 0o600, flag: "wx" });
      await rename(tmp, resolvedSlotsFile);
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  function applyPendingClaims() {
    if (!pendingClaims.size) return;
    for (const [slot, claimedKey] of pendingClaims) {
      if (!SLOT_TAG_RE.test(slot) || !isValidPoolAuthKey(claimedKey)) continue;
      // If this slot already owns another live key, Magpie's settle() deduplicates
      // the sign-in onto the existing key automatically by matching whoOf().
      if (slotMap.has(slot)) continue;
      for (const [otherSlot, otherKey] of slotMap.entries()) {
        if (otherKey === claimedKey) {
          slotMap.delete(otherSlot);
          if (claimedKey === POOL_PROVIDER) deferredBareClean = false;
        }
      }
      slotMap.set(slot, claimedKey);
    }
    pendingClaims.clear();
  }

  const run = async (callerActiveKey = "") => {
    await loadSlots();
    applyPendingClaims();

    const rows = await poolRead();
    const valid = [];
    const seenSlots = new Set();
    for (const item of Array.isArray(rows) ? rows : []) {
      if (!isPoolRecord(item)) continue;
      const slot = accountSlotTag(item.email);
      if (seenSlots.has(slot)) continue;
      seenSlots.add(slot);
      valid.push({ item, slot });
    }

    const activeScopedKey = callerActiveKey ||
      (typeof getActiveKey === "function" ? String(getActiveKey() || "") : "");
    const canTouchBareKey = !activeScopedKey || activeScopedKey === POOL_PROVIDER;

    // Identify keys tied to accounts no longer present in the vault.
    const staleKeys = [];
    for (const [slot, key] of [...slotMap.entries()]) {
      if (seenSlots.has(slot)) continue;
      slotMap.delete(slot);
      if (key === POOL_PROVIDER && !canTouchBareKey) {
        deferredBareClean = true;
      } else {
        staleKeys.push(key);
      }
    }

    if (deferredBareClean && canTouchBareKey) {
      deferredBareClean = false;
      if (!staleKeys.includes(POOL_PROVIDER) && ![...slotMap.values()].includes(POOL_PROVIDER))
        staleKeys.push(POOL_PROVIDER);
    }

    // Track keys already bound to surviving vault accounts.
    const usedKeys = new Set();
    for (const { slot } of valid) {
      const existing = slotMap.get(slot);
      if (existing && !usedKeys.has(existing)) {
        usedKeys.add(existing);
      } else if (existing) {
        slotMap.delete(slot);
      }
    }

    // Assign canonical keys to newly added vault accounts.
    const bareRemovedThisPass = staleKeys.includes(POOL_PROVIDER);
    for (const { slot } of valid) {
      if (slotMap.has(slot)) continue;
      let assigned = `${POOL_PROVIDER}#${slot}`;
      // Use the unsuffixed provider key for the first unassigned account when
      // free (outside mismatched scopes), cleanly upgrading any legacy entry.
      if (canTouchBareKey && !bareRemovedThisPass && !usedKeys.has(POOL_PROVIDER) &&
          valid.length > 0 && slotMap.size === 0) {
        assigned = POOL_PROVIDER;
      }
      if (usedKeys.has(assigned)) {
        // Rare case: key collides; fall back to deterministic slot suffix.
        assigned = `${POOL_PROVIDER}#${slot}`;
      }
      slotMap.set(slot, assigned);
      usedKeys.add(assigned);
    }

    // Remove obsolete Magpie auth entries.
    for (const staleKey of staleKeys) {
      await runOutside(() => client.auth.remove({ path: { id: staleKey } }));
    }

    // If pool is completely empty, also remove legacy bare provider key.
    if (valid.length === 0) {
      if (canTouchBareKey && !staleKeys.includes(POOL_PROVIDER)) {
        await runOutside(() => client.auth.remove({ path: { id: POOL_PROVIDER } }));
      } else if (!canTouchBareKey) {
        deferredBareClean = true;
      }
      slotMap.clear();
      await persistSlots();
      return { connected: false, count: 0, accounts: [] };
    }

    // Register / refresh every pooled account as its own Magpie account row.
    const accounts = [];
    for (const { item, slot } of valid) {
      const key = slotMap.get(slot);
      if (!key) continue;
      if (key === POOL_PROVIDER && !canTouchBareKey) {
        accounts.push({ key, slot, label: formatAccountSlotLabel(item.email) });
        continue;
      }
      const body = buildSlotAuthBody(item.email);
      await runOutside(() => client.auth.set({ path: { id: key }, body }));
      accounts.push({ key, slot, label: body.accountId });
    }

    await persistSlots();
    return { connected: true, count: valid.length, accounts };
  };

  return {
    claimKey(emailOrSlot, magpieKey) {
      const slot = SLOT_TAG_RE.test(String(emailOrSlot || ""))
        ? String(emailOrSlot)
        : accountSlotTag(emailOrSlot);
      if (SLOT_TAG_RE.test(slot) && isValidPoolAuthKey(magpieKey))
        pendingClaims.set(slot, magpieKey);
    },
    sync() {
      const callerActiveKey = typeof getActiveKey === "function"
        ? String(getActiveKey() || "")
        : "";
      const next = queued.then(() => run(callerActiveKey), () => run(callerActiveKey));
      queued = next.catch(() => {});
      return next;
    },
  };
}
