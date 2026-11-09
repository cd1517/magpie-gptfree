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

export function poolHasAccounts(rows) {
  return Array.isArray(rows) &&
    rows.some((item) =>
      typeof item?.email === "string" &&
      typeof item?.accessToken === "string" && item.accessToken.length > 0 &&
      typeof item?.password === "string" &&
      typeof item?.totp === "string");
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
    const connected = poolHasAccounts(rows);
    const path = { id: POOL_PROVIDER };
    if (connected) {
      await client.auth.set({
        path,
        body: {
          type: "api",
          key: POOL_MARKER,
          accountId: "GPTFree local pool",
        },
      });
    } else {
      await client.auth.remove({ path });
    }
    return { connected, count: Array.isArray(rows) ? rows.length : 0 };
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
