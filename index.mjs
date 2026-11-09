/**
 * Standalone Magpie GUI and token-pool providers.
 * GUI entry runs in the plugin-host and serves its own sandboxed page.
 * Import is initiated with Magpie Plugins -> GPTFree Account Import.
 */
import { listPool } from "./lib/pool-vault.mjs";
import { CODEX_BASE, discoverPoolModels, poolFetch } from "./lib/codex-pool.mjs";
import { GUI_PORT, startGuiServer } from "./lib/gui-service.mjs";

export const GPTFreeGuiPlugin = async (_ctx, options) => {
  const raw = options?.port ?? GUI_PORT;
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("GPTFree GUI: invalid service port");
  await startGuiServer({ port });
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
    methods: [{
      type: "api", keyless: true,
      label: "启用本地 GPTFree Token 号池",
      async authorize() {
        const rows = await listPool();
        if (!rows.length) return {
          type: "failed",
          error: "本地号池为空：请在 Plugins → GPTFree 账号导入 中选择 TXT 文件并导入",
        };
        return {
          type: "success", key: "local-pool-enabled",
          metadata: { accountId: "GPTFree local pool" },
        };
      },
    }],
    async loader(getAuth) {
      const auth = await getAuth();
      if (auth?.type !== "api") return {};
      return {
        baseURL: CODEX_BASE,
        apiKey: "local-pool-enabled",
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
