/**
 * Magpie provider connection for the local GPTFree token pool.
 *
 * Importing accounts is the only login action the owner needs. Magpie's
 * plugin-auth store gets a non-secret *local pool marker* so its native
 * provider machinery can discover models and use our fetch hook.
 *
 * Never save owner credentials, JWTs, or OAuth refresh tokens in Magpie's
 * plugin-auth store; they stay in the separately encrypted local vault.
 */
import { listPool } from "./pool-vault.mjs";

export const POOL_PROVIDER = "gptfree-pool";
export const POOL_MARKER = "gptfree-local-pool-v1";

function isPoolRecord(item) {
  return typeof item?.email === "string" &&
    typeof item?.accessToken === "string" && item.accessToken.length > 0 &&
    typeof item?.password === "string" &&
    typeof item?.totp === "string";
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

/**
 * Synchronize the host's provider registration with the encrypted vault.
 * This does not imply that any token has passed online validation: Magpie's
 * provider.models and the request adapter still verify upstream access.
 */
export function createPoolConnector(client, { poolRead = listPool } = {}) {
  if (typeof client?.auth?.set !== "function" ||
      typeof client?.auth?.remove !== "function")
    throw new Error("Magpie's host does not support automatic provider registration");
  let queued = Promise.resolve();
  const run = async () => {
    const rows = await poolRead();
    const count = countValidPoolAccounts(rows);
    const connected = count > 0;
    const path = { id: POOL_PROVIDER };
    if (connected) {
      await client.auth.set({
        path,
        body: {
          type: "api",
          key: POOL_MARKER,
          accountId: formatPoolAccountLabel(count),
        },
      });
    } else {
      await client.auth.remove({ path });
    }
    return { connected, count };
  };
  // Serializes imports/removals sharing a single Magpie sign-in marker.
  return {
    sync() {
      const next = queued.then(run, run);
      queued = next.catch(() => {});
      return next;
    },
  };
}
