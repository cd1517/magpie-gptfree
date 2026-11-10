/**
 * Local non-secret quota and image call statistics store.
 *
 * Keyed strictly by `accountSlotTag(email)` (`s<sha256-prefix>`). Never writes raw
 * emails, passwords, TOTP secrets, JWTs, or URLs to disk. Uses serialized atomic
 * writes inside `poolDir()/pool-stats.json` (or an isolated in-memory store).
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { accessTokenState, safeAccountName } from "./credentials.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "./pool-connection.mjs";
import { poolDir } from "./pool-vault.mjs";

const STATS_FILE = "pool-stats.json";
const FORMAT_VERSION = 1;
const SLOT_TAG_RE = /^s[0-9a-f]{10}$/;

let pending = Promise.resolve();
function exclusive(work) {
  const run = pending.then(work, work);
  pending = run.catch(() => {});
  return run;
}

export function defaultStatsFile() {
  return join(poolDir(), STATS_FILE);
}

export function createEmptyStats() {
  return {
    version: FORMAT_VERSION,
    totals: { successCalls: 0, failCalls: 0 },
    accounts: {},
  };
}

export function sanitizeStatsMessage(message, limit = 180) {
  const cleaned = String(message || "")
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "[redacted-token]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/[\r\n\0\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, limit);
}

function cleanIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function cleanCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function cleanQuota(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function cleanPlanType(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 32);
  return /^[a-zA-Z0-9._ -]+$/.test(trimmed) ? trimmed : null;
}

function normalizeAccountEntry(entry) {
  const src = entry && typeof entry === "object" ? entry : {};
  return {
    imageQuota: cleanQuota(src.imageQuota),
    hasImageLimit: typeof src.hasImageLimit === "boolean" ? src.hasImageLimit : null,
    planType: cleanPlanType(src.planType),
    restoreAt: cleanIso(src.restoreAt),
    limitedUntil: cleanIso(src.limitedUntil),
    quotaCheckedAt: cleanIso(src.quotaCheckedAt),
    quotaError: typeof src.quotaError === "string" && src.quotaError.trim()
      ? sanitizeStatsMessage(src.quotaError)
      : null,
    successCalls: cleanCount(src.successCalls),
    failCalls: cleanCount(src.failCalls),
    lastUsedAt: cleanIso(src.lastUsedAt),
  };
}

function normalizeStats(parsed) {
  const base = createEmptyStats();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return base;
  base.totals = {
    successCalls: cleanCount(parsed.totals?.successCalls),
    failCalls: cleanCount(parsed.totals?.failCalls),
  };
  if (parsed.accounts && typeof parsed.accounts === "object" && !Array.isArray(parsed.accounts)) {
    for (const [slotTag, entry] of Object.entries(parsed.accounts)) {
      if (!SLOT_TAG_RE.test(slotTag)) continue;
      base.accounts[slotTag] = normalizeAccountEntry(entry);
    }
  }
  return base;
}

function resolveTargetSlot(emailOrTag, explicitTag = "") {
  if (typeof explicitTag === "string" && SLOT_TAG_RE.test(explicitTag)) return explicitTag;
  if (typeof emailOrTag === "string") {
    const trimmed = emailOrTag.trim();
    if (SLOT_TAG_RE.test(trimmed)) return trimmed;
    if (trimmed.includes("@")) return accountSlotTag(trimmed);
  }
  return "";
}

async function readFromDisk(file) {
  try {
    const raw = await readFile(file, "utf8");
    return normalizeStats(JSON.parse(raw));
  } catch {
    return createEmptyStats();
  }
}

async function writeToDisk(file, stats) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const payload = JSON.stringify(normalizeStats(stats), null, 2);
  try {
    await writeFile(tmp, payload, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    try { await chmod(file, 0o600); } catch {}
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function resolveStoreTarget({ statsFile, statsStore } = {}) {
  if (statsStore && typeof statsStore === "object") return { memory: statsStore, file: null };
  if (statsFile === false || statsFile === null) return { memory: null, file: null };
  if (typeof statsFile === "string" && statsFile) return { memory: null, file: statsFile };
  return { memory: null, file: defaultStatsFile() };
}

export async function readPoolStats(opts = {}) {
  const { memory, file } = resolveStoreTarget(opts);
  if (memory) {
    if (!memory.state) memory.state = createEmptyStats();
    return normalizeStats(memory.state);
  }
  if (!file) return createEmptyStats();
  return exclusive(() => readFromDisk(file));
}

async function updatePoolStats(mutator, opts = {}) {
  const { memory, file } = resolveStoreTarget(opts);
  if (memory) {
    if (!memory.state) memory.state = createEmptyStats();
    const current = normalizeStats(memory.state);
    const next = (await mutator(current)) || current;
    memory.state = normalizeStats(next);
    return memory.state;
  }
  if (!file) {
    const current = createEmptyStats();
    return normalizeStats((await mutator(current)) || current);
  }
  return exclusive(async () => {
    const current = await readFromDisk(file);
    const next = (await mutator(current)) || current;
    const normalized = normalizeStats(next);
    await writeToDisk(file, normalized);
    return normalized;
  });
}

export function createInMemoryStatsStore() {
  return { state: createEmptyStats() };
}

export async function recordQuotaCheck({
  email = "",
  slotTag = "",
  quota = null,
  restoreAt = null,
  hasImageLimit = null,
  planType = null,
  error = null,
  rateLimited = false,
  retryAfter = null,
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  if (!tag) return null;
  const checkedAt = new Date().toISOString();
  return updatePoolStats((stats) => {
    const prev = normalizeAccountEntry(stats.accounts[tag]);
    if (error && !rateLimited) {
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        quotaCheckedAt: checkedAt,
        quotaError: sanitizeStatsMessage(error) || "额度查询失败",
      });
      return stats;
    }

    if (rateLimited) {
      const retrySec = Number(retryAfter);
      const limitedUntil = Number.isFinite(retrySec) && retrySec > 0
        ? new Date(Date.now() + retrySec * 1000).toISOString()
        : cleanIso(restoreAt) || prev.limitedUntil;
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        imageQuota: 0,
        limitedUntil,
        restoreAt: cleanIso(restoreAt) || prev.restoreAt,
        planType: planType || prev.planType,
        quotaCheckedAt: checkedAt,
        quotaError: null,
      });
      return stats;
    }

    const numericQuota = cleanQuota(quota);
    const cleanRestore = cleanIso(restoreAt);
    stats.accounts[tag] = normalizeAccountEntry({
      ...prev,
      imageQuota: numericQuota ?? 0,
      hasImageLimit: typeof hasImageLimit === "boolean" ? hasImageLimit : prev.hasImageLimit,
      planType: planType || prev.planType,
      restoreAt: cleanRestore,
      limitedUntil: (numericQuota ?? 0) === 0 ? cleanRestore : null,
      quotaCheckedAt: checkedAt,
      quotaError: null,
    });
    return stats;
  }, opts);
}

export async function recordImageCall({
  email = "",
  slotTag = "",
  success = false,
  count = 1,
  rateLimited = false,
  retryAfter = null,
  error = "",
} = {}, opts = {}) {
  const tag = resolveTargetSlot(email, slotTag);
  const usedCount = Math.max(1, cleanCount(count) || 1);
  const nowIso = new Date().toISOString();

  return updatePoolStats((stats) => {
    if (success) {
      stats.totals.successCalls += usedCount;
    } else {
      stats.totals.failCalls += 1;
    }
    if (!tag) return stats;

    const prev = normalizeAccountEntry(stats.accounts[tag]);
    if (success) {
      let nextQuota = prev.imageQuota;
      if (typeof nextQuota === "number") {
        nextQuota = Math.max(0, nextQuota - usedCount);
      }
      stats.accounts[tag] = normalizeAccountEntry({
        ...prev,
        imageQuota: nextQuota,
        quotaError: null,
        successCalls: prev.successCalls + usedCount,
        lastUsedAt: nowIso,
      });
      return stats;
    }

    let nextQuota = prev.imageQuota;
    let nextLimitedUntil = prev.limitedUntil;
    let nextCheckedAt = prev.quotaCheckedAt;
    if (rateLimited) {
      nextQuota = 0;
      const retrySec = Number(retryAfter);
      if (Number.isFinite(retrySec) && retrySec > 0) {
        nextLimitedUntil = new Date(Date.now() + retrySec * 1000).toISOString();
      }
      nextCheckedAt = nowIso;
    }
    stats.accounts[tag] = normalizeAccountEntry({
      ...prev,
      imageQuota: nextQuota,
      limitedUntil: nextLimitedUntil,
      quotaCheckedAt: nextCheckedAt,
      quotaError: rateLimited ? null : (error ? prev.quotaError : prev.quotaError),
      failCalls: prev.failCalls + 1,
      lastUsedAt: nowIso,
    });
    return stats;
  }, opts);
}

export async function removeAccountStats(emailOrTag, opts = {}) {
  const tag = resolveTargetSlot(emailOrTag);
  if (!tag) return null;
  return updatePoolStats((stats) => {
    delete stats.accounts[tag];
    return stats;
  }, opts);
}

export function isAccountRateLimited(email, stats, { nowMs = Date.now() } = {}) {
  const tag = resolveTargetSlot(email);
  if (!tag) return false;
  const entry = stats?.accounts?.[tag];
  if (!entry || cleanQuota(entry.imageQuota) !== 0) return false;
  const resetIso = cleanIso(entry.limitedUntil) || cleanIso(entry.restoreAt);
  if (!resetIso) return true;
  const resetMs = Date.parse(resetIso);
  return !Number.isFinite(resetMs) || resetMs > nowMs;
}

export function summarizePoolStats(rows, stats, { nowMs = Date.now(), resolveId = null } = {}) {
  const safeStats = normalizeStats(stats);
  const accounts = [];
  let active = 0;
  let limited = 0;
  let unchecked = 0;
  let errored = 0;
  let needsRenew = 0;
  let checked = 0;
  let totalQuota = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.email !== "string" || !row.email.includes("@")) continue;
    const slotTag = accountSlotTag(row.email);
    const slotLabel = formatAccountSlotLabel(row.email);
    const tokenState = row.accessToken ? accessTokenState(row.accessToken).state : "missing";
    const hasAccess = !!row.accessToken;
    const rec = safeStats.accounts[slotTag] || null;

    const imageQuota = rec ? rec.imageQuota : cleanQuota(row.imageQuota);
    const quotaError = rec?.quotaError || (typeof row.quotaError === "string" ? sanitizeStatsMessage(row.quotaError) : null);
    const quotaResetAt = rec?.limitedUntil || rec?.restoreAt || cleanIso(row.quotaResetAt);
    const quotaCheckedAt = rec?.quotaCheckedAt || cleanIso(row.quotaCheckedAt);
    const hasImageLimit = rec?.hasImageLimit ?? (typeof row.hasImageLimit === "boolean" ? row.hasImageLimit : null);
    const planType = rec?.planType || cleanPlanType(row.planType);
    const successCalls = rec ? rec.successCalls : cleanCount(row.successCalls);
    const failCalls = rec ? rec.failCalls : cleanCount(row.failCalls);
    const lastUsedAt = rec?.lastUsedAt || cleanIso(row.lastUsedAt);

    const resetMs = quotaResetAt ? Date.parse(quotaResetAt) : NaN;
    const cooldownExpired = imageQuota === 0 && Number.isFinite(resetMs) && resetMs <= nowMs;
    const tokenUsable = hasAccess && tokenState === "unexpired_unverified";
    const tokenBroken = !hasAccess || tokenState === "missing" || tokenState === "invalid";

    let quotaStatus;
    if (tokenBroken) {
      quotaStatus = "unavailable";
      needsRenew++;
    } else if (imageQuota === 0) {
      quotaStatus = "limited";
      limited++;
    } else if (typeof imageQuota === "number" && imageQuota > 0) {
      if (tokenUsable) {
        quotaStatus = "available";
        active++;
        totalQuota += imageQuota;
      } else {
        quotaStatus = "needs_renew";
        needsRenew++;
      }
    } else if (quotaError) {
      quotaStatus = "error";
      errored++;
    } else {
      quotaStatus = "unchecked";
      unchecked++;
    }

    if (imageQuota !== null) checked++;

    accounts.push({
      ...(typeof resolveId === "function" ? { id: resolveId(row.email) } : {}),
      email: safeAccountName(row.email),
      slotLabel,
      slotTag,
      updatedAt: row.updatedAt || null,
      hasAccess,
      tokenState,
      imageQuota,
      quotaStatus,
      hasImageLimit,
      planType,
      quotaResetAt,
      quotaCheckedAt,
      quotaError,
      cooldownExpired,
      successCalls,
      failCalls,
      lastUsedAt,
    });
  }

  return {
    accounts,
    quotaStats: {
      total: accounts.length,
      active,
      limited,
      unchecked,
      errored,
      needsRenew,
      checked,
      totalQuota,
      totalSuccess: safeStats.totals.successCalls,
      totalFail: safeStats.totals.failCalls,
      updatedAt: new Date(nowMs).toISOString(),
    },
  };
}
