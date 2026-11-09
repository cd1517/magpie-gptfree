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
    single: true,
    // Magpie's Providers page REQUIRES a sign-in method for an unsigned
    // provider. This single method opens our GUI; it never asks for
    // email/password/2FA or a standalone API key here. GUI import itself
    // performs OAuth and activates the pool as soon as an account succeeds.
    methods: [{
      type: "oauth",
      label: "打开 GPTFree 图形界面导入账号",
      async authorize(_inputs, { signal } = {}) {
        const service = await startGuiServer({ port: GUI_PORT });
        const entry = service.issueProviderEntry();
        return {
          url: entry.url,
          method: "auto",
          instructions: "在打开的 GPTFree 图形界面中选择 TXT 文件并点击「开始批量导入」。首次成功入池后 Magpie 将自动完成此步骤，不需要另外登录。",
          async callback(_code, { signal: callbackSignal } = {}) {
            const outcome = await entry.wait({ signal: callbackSignal || signal });
            if (!outcome.ok) {
              return { type: "failed", error: outcome.error || "导入尚未完成，请在 GPTFree GUI 中查看详细状态" };
            }
            return {
              type: "success",
              key: POOL_MARKER,
              metadata: { accountId: "GPTFree local pool" },
            };
          },
        };
      },
    }],
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
