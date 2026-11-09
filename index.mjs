/**
 * Standalone Magpie GUI and token-pool providers.
 * GUI entry runs in the plugin-host and serves its own sandboxed page.
 * Import is initiated with Magpie Plugins -> GPTFree Account Import.
 */
import { CODEX_BASE, discoverPoolModels, poolFetch } from "./lib/codex-pool.mjs";
import { GUI_PORT, startGuiServer } from "./lib/gui-service.mjs";
import { createPoolConnector, POOL_MARKER } from "./lib/pool-connection.mjs";

export const GPTFreeGuiPlugin = async (ctx, options) => {
  const raw = options?.port ?? GUI_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("GPTFree GUI: invalid service port");
  const connection = createPoolConnector(ctx.client);
  await startGuiServer({ port, onPoolChange: () => connection.sync() });
  // Restore Magpie's non-secret local-pool connection automatically after
  // restarting. A corrupt vault must not make the GUI inaccessible.
  try {
    await connection.sync();
  } catch {
    await ctx.client.app.log({
      body: { service: "gptfree", level: "warn",
        message: "Could not restore local account-pool state; inspect GUI pool storage" },
    }).catch(() => {});
  }
  return {};
};

/**
 * Separate, access-only account pool mode.
 * A JWT is admitted only after Codex /models validates it. A token with no
 * refresh token is not a permanent login: on expiry the plugin attempts
 * normal browser OAuth (including user-driven security challenges).
 */
export const GPTFreePoolPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {};
    cfg.provider["gptfree-pool"] ??= {
      name: "GPTFree Codex Pool (standalone)",
      npm: "@ai-sdk/openai",
      api: CODEX_BASE,
      models: {},
    };
  },
  auth: {
    provider: "gptfree-pool",
    maxConcurrency: 2,
    // No interactive "log in / enable" step: the GUI import registers
    // this provider by client.auth.set when it successfully writes the pool.
    methods: [],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api") return {};
      return {
        baseURL: CODEX_BASE,
        apiKey: POOL_MARKER,
        fetch: (input, init) => poolFetch(input, init),
      };
    },
  },
  provider: {
    id: "gptfree-pool",
    async models(_provider, { auth } = {}) {
      if (auth?.type !== "api") return {};
      return discoverPoolModels();
    },
  },
});
