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
import { listPool } from "./pool-vault.mjs";
import { poolHasAccounts } from "./pool-connection.mjs";

const FORM_PROMPTS = [
  {
    type: "select",
    key: "source",
    message: "GPTFree · 账号导入",
    options: [
      { label: "从 TXT 文件批量导入账号", value: "txt", hint: "选择文件后自动 OAuth / TOTP 登录并入池" },
      { label: "使用本机已有账号池", value: "existing", hint: "已经导入过时，无需再次选择 TXT" },
    ],
  },
  {
    type: "select",
    key: "ownership",
    message: "账号授权确认",
    when: { key: "source", op: "eq", value: "txt" },
    options: [
      { label: "确认：这些账号由我持有或获授权管理", value: "yes" },
      { label: "取消导入", value: "no" },
    ],
  },
];


export function nativeImportMethod({
  picker = pickAccountTxt,
  server = () => startGuiServer({ port: GUI_PORT }),
  readPool = listPool,
} = {}) {
  return {
    type: "oauth",
    label: "批量导入或管理 GPTFree 账号",
    // Native Magpie sign-in overlay prompts run BEFORE authorize().
    // Clicking the provider name now displays this form, not an OS dialog.
    // No password/TOTP/token is a prompt value: Magpie persists inputs
    // into auth metadata after sign-in.
    prompts: FORM_PROMPTS,
    async authorize(inputs, { signal } = {}) {
      if (inputs?.source === "existing") {
        try {
          if (!poolHasAccounts(await readPool()))
            return { type: "failed", error: "本机号池为空；请返回表单选择 TXT 批量导入" };
          // The marker only connects the existing encrypted local pool.
          // Actual token validity is checked by the model discovery hook.
          return {
            url: "", opened: true, method: "auto",
            instructions: "已找到本机账号池，正在同步 Magpie 供应商状态。",
            async callback() {
              return { type: "success", key: POOL_MARKER,
                metadata: { accountId: "GPTFree local pool" } };
            },
          };
        } catch {
          return { type: "failed", error: "无法读取本机号池，请检查 GPTFree 插件内的账号管理页" };
        }
      }
      if (inputs?.source !== "txt")
        return { type: "failed", error: "请先在 Magpie 表单中选择 TXT 批量导入方式" };
      if (inputs.ownership !== "yes")
        return { type: "failed", error: "请在表单中确认账号管理授权后再导入" };
      if (signal?.aborted)
        return { type: "failed", error: "导入已取消" };
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
        error: "未选择 TXT 文件，账号未导入。可以重新点击 GPTFree 进入导入表单",
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
