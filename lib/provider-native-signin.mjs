/**
 * Magpie Providers -> GPTFree sign-in, WITHOUT launching an importer URL.
 *
 * Magpie's sign-in HTTP flow runs in the plugin host without opening an
 * external browser importer:
 *  - Choosing a TXT file either imports all valid accounts right away (or
 *    skips invalid lines), registering every admitted account as its own row
 *    in Magpie Providers;
 *  - Any malformed TXT file (or choosing "load into editor") stages the file
 *    securely in the plugin GUI's in-memory draft so opening
 *    Plugins -> GPTFree 账号导入 immediately fills the editable textarea;
 *  - Choosing "sync existing pool" registers every already-pooled account in
 *    Magpie Providers without re-logging in.
 */
import { pickAccountTxt } from "./native-file-dialog.mjs";
import { startGuiServer, GUI_PORT } from "./gui-service.mjs";
import {
  POOL_MARKER, POOL_PROVIDER, accountSlotTag, formatAccountSlotLabel, isPoolRecord,
} from "./pool-connection.mjs";
import { listPool } from "./pool-vault.mjs";

const FORM_PROMPTS = [
  {
    type: "select",
    key: "source",
    message: "GPTFree · 多账号批量导入",
    options: [
      {
        label: "从 TXT 文件批量导入账号（多账号分别入池）",
        value: "txt",
        hint: "选文件后后台批量登录/复用 Token，成功账号会逐一出现在 Providers；遇到格式错误会自动暂存到插件编辑框",
      },
      {
        label: "选择 TXT 并预加载到「GPTFree 账号导入」文本框编辑",
        value: "edit",
        hint: "适合文件内容格式不确定时：选完文件后直接在左侧 Plugins → GPTFree 账号导入 文本框编辑改错",
      },
      {
        label: "同步本机已有 GPTFree 账号池到 Providers（全部账号）",
        value: "existing",
        hint: "已经在左侧 Plugins → GPTFree 账号导入 完成批量导入时，点此一键同步全部账号",
      },
    ],
  },
  {
    type: "select",
    key: "ownership",
    message: "账号授权与容错方式确认",
    when: { key: "source", op: "eq", value: "txt" },
    options: [
      { label: "确认授权，立即批量导入（有格式错误时先暂存编辑）", value: "yes" },
      { label: "确认授权，自动跳过格式错误行并导入有效账号", value: "skip" },
      { label: "取消导入", value: "no" },
    ],
  },
];

export function nativeImportMethod({
  picker = pickAccountTxt,
  server = () => startGuiServer({ port: GUI_PORT }),
  readPool = listPool,
  syncPool = null,
  claimSlotKey = null,
  activeKey = null,
} = {}) {
  return {
    type: "oauth",
    label: "批量导入或管理 GPTFree 多账号池",
    // Native Magpie sign-in overlay prompts run BEFORE authorize().
    // No password/TOTP/token is ever a prompt value because Magpie may
    // store inputs into auth metadata after sign-in.
    prompts: FORM_PROMPTS,
    async authorize(inputs, { signal } = {}) {
      if (inputs?.source === "existing") {
        try {
          const valid = (await readPool()).filter(isPoolRecord);
          const count = valid.length;
          if (!count)
            return { type: "failed", error: "本机号池为空；请在 Plugins → GPTFree 账号导入或选择 TXT 批量导入" };
          const first = valid[0];
          const firstSlot = accountSlotTag(first.email);
          const firstLabel = formatAccountSlotLabel(first.email);
          const signInKey = typeof activeKey === "function" ? activeKey() : "";
          return {
            url: "", opened: true, method: "auto",
            instructions: `已找到本机账号池（共 ${count} 个账号），正在把全部账号分别同步到 Magpie Providers。`,
            async callback() {
              if (typeof claimSlotKey === "function")
                claimSlotKey(firstSlot, signInKey || POOL_PROVIDER);
              if (typeof syncPool === "function")
                await syncPool().catch(() => {});
              return {
                type: "success",
                key: POOL_MARKER,
                metadata: {
                  email: firstLabel,
                  poolSlot: firstSlot,
                },
              };
            },
          };
        } catch {
          return { type: "failed", error: "无法读取本机号池，请检查 GPTFree 插件内的账号管理页" };
        }
      }

      if (inputs?.source === "edit") {
        if (signal?.aborted)
          return { type: "failed", error: "操作已取消" };
        let file;
        try { file = await picker({ signal }); }
        catch (error) {
          const known = /系统文件选择器不可用|当前平台没有可用|请选择.*\.txt/.test(String(error?.message || ""));
          return {
            type: "failed",
            error: known
              ? String(error.message).slice(0, 200)
              : "无法打开系统文件选择器；请直接使用左侧 Plugins → GPTFree 账号导入 选择或粘贴账号",
          };
        }
        if (signal?.aborted || !file) {
          return {
            type: "failed",
            error: "未选择 TXT 文件，您可以直接打开左侧 Plugins → GPTFree 账号导入 选择文件或粘贴文本",
          };
        }
        try {
          const service = await server();
          const info = await service.stageDraft(file);
          return {
            type: "failed",
            error: `已将 ${info.filename}（${info.count} 条有效，${info.errors} 条格式错误）填入左侧「Plugins → GPTFree 账号导入」文本框！请打开该页编辑后点击「导入并授权入池」。`,
          };
        } catch (error) {
          const known = /无法读取选中的 TXT|账号文件超过|单次最多导入/.test(String(error?.message || ""));
          return {
            type: "failed",
            error: known ? String(error.message).slice(0, 200) : "预加载 TXT 到编辑框失败，请在左侧 GPTFree 账号导入页直接选择文件",
          };
        }
      }

      if (inputs?.source !== "txt")
        return { type: "failed", error: "请先在 Magpie 表单中选择 TXT 批量导入方式" };
      if (!["yes", "skip"].includes(inputs.ownership))
        return { type: "failed", error: "请在表单中确认账号管理授权后再导入" };
      if (signal?.aborted)
        return { type: "failed", error: "导入已取消" };

      let file;
      try { file = await picker({ signal }); }
      catch (error) {
        const known = /系统文件选择器不可用|当前平台没有可用|请选择.*\.txt/.test(String(error?.message || ""));
        return {
          type: "failed",
          error: known
            ? String(error.message).slice(0, 200)
            : "无法打开系统文件选择器；请使用 Magpie 左侧 Plugins → GPTFree 账号导入",
        };
      }
      if (signal?.aborted || !file) return {
        type: "failed",
        error: "未选择 TXT 文件，账号未导入。可以重新点击 GPTFree 进入导入表单",
      };

      const skipInvalid = inputs.ownership === "skip";
      const signInKey = typeof activeKey === "function" ? activeKey() : "";
      let job;
      try {
        const service = await server();
        // Do not pass authorize's short-lived signal into the background
        // batch. Magpie aborts it immediately after authorize returns.
        job = await service.startNativeImport(file, {
          mode: "pool",
          skipInvalid,
          onFirstAccount: (acc) => {
            if (acc?.slotTag && typeof claimSlotKey === "function")
              claimSlotKey(acc.slotTag, signInKey || POOL_PROVIDER);
          },
        });
      } catch (error) {
        return {
          type: "failed",
          error: /已有批量导入任务|账号 TXT|无法读取选中的 TXT|账号文件超过|单次最多导入/.test(String(error?.message || ""))
            ? String(error.message).slice(0, 240)
            : "本地导入服务未能启动，请检查左侧 GPTFree 导入页",
        };
      }

      return {
        url: "",
        opened: true,
        method: "auto",
        instructions: "已选中 TXT 并开始后台批量导入：首个账号成功后本对话框即完成，其余账号会自动继续入池并逐个注册到 Providers；也可打开左侧 Plugins → GPTFree 账号导入 查看完整进度与编辑文本。",
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
              metadata: {
                email: first.label || "GPTFree account",
                ...(first.slotTag ? { poolSlot: first.slotTag } : {}),
              },
            };
          } finally {
            callbackSignal?.removeEventListener("abort", cancel);
          }
        },
      };
    },
  };
}
