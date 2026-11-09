/**
 * Magpie Providers -> GPTFree sign-in, WITHOUT launching an importer URL.
 *
 * Magpie's API/keyless sign-in HTTP request times out after 60 seconds.
 * Use its official URL-less OAuth flow instead: the system file chooser
 * runs in authorize (short step), while callback waits for the first
 * successful account. The same Magpie GUI tracks the remaining batch.
 *
 * This hook opens NO importer browser. A vendor's official auth challenge
 * can still require a separate browser for security verification.
 */
import { pickAccountTxt } from "./native-file-dialog.mjs";
import { startGuiServer, GUI_PORT } from "./gui-service.mjs";
import { POOL_MARKER } from "./pool-connection.mjs";

export function nativeImportMethod({
  picker = pickAccountTxt,
  server = () => startGuiServer({ port: GUI_PORT }),
} = {}) {
  return {
    type: "oauth",
    label: "选择 TXT 文件并自动导入 GPTFree",
    async authorize(_inputs, { signal } = {}) {
      let file;
      try { file = await picker({ signal }); }
      catch (error) {
        const known = /系统文件选择器不可用|当前平台没有可用|请选择.*\.txt/.test(String(error?.message || ""));
        return { type: "failed", error: known ?
          String(error.message).slice(0, 200) :
          "无法打开系统文件选择器；请使用 Magpie 左侧 Plugins → GPTFree 账号导入" };
      }
      if (signal?.aborted || !file) return {
        type: "failed",
        error: "已取消选择账号文件；可直接使用左侧 Plugins → GPTFree 账号导入",
      };
      let job;
      try {
        const service = await server();
        // Do not pass authorize's short-lived signal into the background
        // batch. Magpie aborts it immediately after authorize returns.
        job = await service.startNativeImport(file, { mode: "pool" });
      } catch (error) {
        return {
          type: "failed",
          error: /已有批量导入任务|账号 TXT 格式不正确|无法读取选中的 TXT/.test(String(error?.message || "")) ?
            String(error.message).slice(0, 200) :
            "本地导入服务未能启动，请检查左侧 GPTFree 导入页",
        };
      }
      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: "已选择 TXT 并自动开始导入，请在 Magpie 左侧 Plugins → GPTFree 账号导入查看进度；第一个账号成功后这里自动完成，无需再点击登录。",
        async callback(_code, { signal: callbackSignal } = {}) {
          const cancel = () => job.cancel();
          if (callbackSignal?.aborted) job.cancel();
          else callbackSignal?.addEventListener("abort", cancel, { once: true });
          try {
            const first = await job.first;
            if (!first.ok) return {
              type: "failed",
              error: first.error || "账号尚未成功入池，请在左侧 GPTFree 页面查看",
            };
            return {
              type: "success",
              key: POOL_MARKER,
              metadata: { accountId: "GPTFree local pool" },
            };
          } finally {
            callbackSignal?.removeEventListener("abort", cancel);
          }
        },
      };
    },
  };
}
