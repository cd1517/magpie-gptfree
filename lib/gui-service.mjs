/**
 * Magpie GPTFree GUI backend.
 *
 * Page CSP forbids fetch(); the entry page navigates its own sandboxed
 * frame to this plugin-owned loopback service.  The service serves its
 * own UI and only accepts API calls bearing a one-page random capability.
 *
 * Magpie web tunnels this service under its per-page URL token. Desktop
 * Magpie uses 127.0.0.1; neither path uses plugins.json for secrets.
 */
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, join, dirname } from "node:path";
import {
  parseAccounts, safeAccountName, accessTokenState, validateProxyUrl, MAX_BYTES,
} from "./credentials.mjs";
import { runBatch } from "./importer.mjs";
import { refreshPoolAccount } from "./codex-pool.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "./pool-connection.mjs";
import { listPool, removePool } from "./pool-vault.mjs";

export const GUI_PORT = 37986;
const SESSION_LIFETIME = 60 * 60 * 1000;
const DRAFT_LIFETIME = 15 * 60 * 1000;
const MAX_POST_BYTES = MAX_BYTES + 8192;
const root = join(dirname(fileURLToPath(import.meta.url)), "../gui");

const now = () => Date.now();
function json(response, status, obj) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(obj));
}
function deny(response, status = 403, reason = "Access denied") {
  json(response, status, { error: reason });
}
function setHeaders(response, origin) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  if (origin === "null") {
    response.setHeader("Access-Control-Allow-Origin", "null");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-GPTFree-Session");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Private-Network", "true");
    response.setHeader("Vary", "Origin");
  }
}
async function bodyJSON(request) {
  if (Number(request.headers["content-length"] || 0) > MAX_POST_BYTES)
    throw Object.assign(new Error("TXT 文件超过 1 MiB"), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_POST_BYTES)
      throw Object.assign(new Error("TXT 文件超过 1 MiB"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("请求 JSON 无效"), { status: 400 });
  }
}
function publicAccount(a, id, idx) {
  return {
    id, line: a.line ?? idx + 1,
    email: safeAccountName(a.email),
    format: a.kind || "standard",
    has2FA: !!a.totp,
    tokenState: a.kind === "access_token" ? a.tokenState : null,
  };
}
function previewOf(parsed) {
  return {
    count: parsed.accounts.length,
    duplicates: parsed.duplicates,
    errors: parsed.errors.slice(0, 100),
    rows: parsed.accounts.map((a, i) => publicAccount(a, "row-" + i, i)),
  };
}

export function createGuiService({
  parse = parseAccounts, batch = runBatch,
  poolRead = listPool, poolRemove = removePool,
  refreshAccount = refreshPoolAccount,
  onPoolChange = null,
  clock = now, port = GUI_PORT, bind = "127.0.0.1",
} = {}) {
  const sessions = new Map();
  let poolChange = onPoolChange;
  const accountIds = new Map();
  const idKey = randomBytes(32);
  let activeJob = null;
  let recentJob = null;
  let pendingDraft = null;
  function prune() {
    const t = clock();
    if (pendingDraft && pendingDraft.expires <= t) pendingDraft = null;
    for (const [id, s] of sessions) {
      if (s.expires < t) {
        s.job?.controller?.abort();
        sessions.delete(id);
      } else if (s.draft && s.draft.expires < t) {
        s.draft = null;
      }
    }
  }
  function stagePendingDraft(source, { filename = "accounts.txt", parsed = null } = {}) {
    let summary = parsed;
    if (!summary) {
      try { summary = parse(source); } catch { summary = { accounts: [], errors: [] }; }
    }
    pendingDraft = {
      source,
      filename: String(filename || "accounts.txt").slice(0, 120),
      validCount: summary?.accounts?.length || 0,
      errorCount: summary?.errors?.length || 0,
      expires: clock() + DRAFT_LIFETIME,
    };
    return pendingDraft;
  }
  function who(email) {
    return createHmac("sha256", idKey).update(email).digest("hex").slice(0, 32);
  }
  function openSession() {
    prune();
    const id = randomBytes(32).toString("hex");
    const s = { expires: clock() + SESSION_LIFETIME, draft: null, job: null };
    sessions.set(id, s);
    return id;
  }
  function session(request) {
    const id = request.headers["x-gptfree-session"];
    if (typeof id !== "string" || id.length !== 64) return null;
    const s = sessions.get(id);
    if (!s || s.expires <= clock()) return null;
    s.expires = clock() + SESSION_LIFETIME;
    return s;
  }
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    setHeaders(res, origin);
    // The import GUI only lives in Magpie's sandboxed plugin frame.
    // Its requests have Origin: null; never trust a regular website.
    const local = "http://127.0.0.1:" + server.address()?.port;
    const allowedOrigin = !origin || origin === "null";
    if (req.headers.host !== new URL(local).host) return deny(res, 403, "Invalid local service host");
    const uri = new URL(req.url || "/", local);
    const route = uri.pathname;
    if (req.method === "OPTIONS") {
      if (!allowedOrigin) return deny(res);
      res.writeHead(204); res.end(); return;
    }
    if (!allowedOrigin) return deny(res);
    if (route === "/ui" && req.method === "GET") {
      // Never expose a provider-login ticket URL: native Providers uses
      // the OS file picker instead of navigating to a browser.
      if (uri.searchParams.has("ticket"))
        return deny(res, 410, "浏览器导入入口已废弃，请在 Magpie 内选择文件");
      const id = openSession();
      const source = await readFile(join(root, "dashboard.html"), "utf8");
      const html = source.replace("__GPTFREE_SESSION__", id)
        .replace("__GPTFREE_ENTRY_MODE__", "sidebar");
      // A sandboxed page has an opaque origin. Safari/WebKit does not
      // reliably resolve 'self' from one, so explicitly name the loopback
      // server as well. Magpie web expands 'self' to its protected page
      // service proxy URL in its own response policy.
      const local = "http://127.0.0.1:" + server.address().port;
      res.setHeader("Content-Security-Policy",
        "default-src 'none'; script-src 'self' " + local + "; " +
        "style-src 'self' " + local + " 'unsafe-inline'; " +
        "connect-src 'self' " + local + "; img-src 'self' " + local + " data:; " +
        "font-src 'self' " + local + "; base-uri 'none'; object-src 'none'; form-action 'none'");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (route === "/assets/app.js" || route === "/assets/style.css") {
      if (req.method !== "GET") return deny(res, 405, "Method not allowed");
      const file = route === "/assets/app.js" ? "app.js" : "style.css";
      res.writeHead(200, {
        "Content-Type": file.endsWith(".js") ?
          "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      });
      res.end(await readFile(join(root, file)));
      return;
    }
    if (!route.startsWith("/api/")) return deny(res, 404, "Not found");
    const s = session(req);
    if (!s) return deny(res, 403, "GUI session expired; reopen the plugin page");
    if (req.method === "POST" &&
        (!req.headers["content-type"]?.startsWith("application/json") ||
         origin !== "null"))
      return deny(res, 403, "Secure GUI request required");
    try {
      if (route === "/api/draft" && req.method === "GET") {
        prune();
        if (!pendingDraft || pendingDraft.expires <= clock()) {
          pendingDraft = null;
          return json(res, 200, { hasDraft: false });
        }
        const draft = pendingDraft;
        pendingDraft = null;
        return json(res, 200, {
          hasDraft: true,
          filename: draft.filename,
          text: draft.source,
          validCount: draft.validCount,
          errorCount: draft.errorCount,
        });
      }
      if (route === "/api/sync" && req.method === "POST") {
        if (!poolChange) return json(res, 200, { synced: false, connected: false, count: 0 });
        const updated = await poolChange();
        return json(res, 200, {
          synced: true,
          connected: updated?.connected === true,
          count: Number(updated?.count || 0),
        });
      }
      if (route === "/api/preview" && req.method === "POST") {
        if (activeJob?.state === "running") return deny(res, 409, "An import is in progress");
        const data = await bodyJSON(req);
        if (typeof data?.text !== "string") return deny(res, 400, "Choose a TXT file");
        const parsed = parse(data.text);
        const summary = previewOf(parsed);
        s.draft = {
          source: data.text,
          expires: clock() + DRAFT_LIFETIME,
          count: parsed.accounts.length,
          invalid: parsed.errors.length,
        };
        s.job = null;
        return json(res, 200, { ...summary, expiresIn: DRAFT_LIFETIME / 1000 });
      }
      if (route === "/api/start" && req.method === "POST") {
        const data = await bodyJSON(req);
        if (!s.draft || s.draft.expires <= clock())
          return deny(res, 410, "Preview expired: select TXT again");
        const skipInvalid = data?.skipInvalid === true;
        if (!s.draft.count || (s.draft.invalid > 0 && !skipInvalid))
          return deny(res, 422, "Fix TXT validation errors before importing");
        if (data?.consent !== true) return deny(res, 403, "Account ownership confirmation required");
        if ((data?.mode ?? "pool") !== "pool")
          return deny(res, 400, "已移除 Codex CLI 导入模式，请使用 GPT号池");
        const proxyCheck = validateProxyUrl(data?.proxy);
        if (proxyCheck.error) return deny(res, 400, proxyCheck.error);
        if (activeJob?.state === "running") return deny(res, 409, "Another import is running");
        const draft = s.draft;
        s.draft = null;
        pendingDraft = null;
        const controller = new AbortController();
        const job = {
          id: randomBytes(16).toString("hex"),
          state: "running", mode: "pool", started: clock(),
          total: draft.count, done: 0, added: 0, reused: 0,
          failed: 0, events: [], eventSeq: 0, controller, result: null,
          providerConnected: null, providerCount: null,
        };
        activeJob = job;
        recentJob = job;
        s.job = job;
        // Respond immediately. Account OAuth and browser work asynchronously.
        queueMicrotask(async () => {
          let syncChain = Promise.resolve();
          try {
            const answer = await batch({
              file: "gui-upload",
              read: async () => draft.source,
              mode: job.mode,
              consent: true,
              skipInvalid,
              proxy: proxyCheck.proxy,
              signal: controller.signal,
              onProgress: (event) => {
                if (job.state !== "running" || controller.signal.aborted) return;
                if (["added", "token_reused", "failed"].includes(event.state)) job.done++;
                if (event.state === "added" || event.state === "token_reused") {
                  job.added++;
                  if (draft.count > 1 && job.added > 1 && poolChange) {
                    syncChain = syncChain.then(() => poolChange()).catch(() => {});
                  }
                }
                if (event.state === "token_reused") job.reused++;
                if (event.state === "failed") job.failed++;
                job.events.push({ ...event, seq: ++job.eventSeq, at: clock() });
                if (job.events.length > 250) job.events.shift();
              },
            });
            await syncChain;
            job.result = {
              total: answer.total,
              added: answer.added, reused: answer.reused,
              failed: answer.failed?.length || 0,
              duplicates: answer.duplicates || 0,
              invalid: answer.invalid?.length || 0,
            };
            job.added = answer.added;
            job.reused = answer.reused;
            job.failed = answer.failed?.length || 0;
            // Successful pool imports must automatically connect all pooled
            // accounts in Magpie Providers.
            if (job.mode === "pool" && answer.added > 0 && poolChange) {
              try {
                const updated = await poolChange();
                job.providerConnected = updated?.connected === true;
                job.providerCount = Number(updated?.count ?? answer.added);
                if (!job.providerConnected)
                  job.message = "账号已导入，但 Magpie 本地号池暂未连接，请检查本地存储状态";
              } catch {
                job.providerConnected = false;
                job.message = "账号已入池，但 Magpie Provider 状态同步失败；请重新打开插件查看";
              }
            }
            job.state = controller.signal.aborted ? "canceled" : "completed";
          } catch {
            await syncChain;
            if (job.added > 0 && poolChange) {
              try {
                const partial = await poolChange();
                job.providerConnected = partial?.connected === true;
                job.providerCount = Number(partial?.count ?? job.added);
              } catch {}
            }
            job.state = controller.signal.aborted ? "canceled" : "error";
            job.message = controller.signal.aborted ?
              "导入已取消" : "导入进程遇到错误；请检查本机 Magpie 与网络/代理配置";
          } finally {
            if (activeJob === job) activeJob = null;
          }
        });
        return json(res, 202, { jobId: job.id, state: "running" });
      }
      if (route === "/api/status" && req.method === "GET") {
        // A new Magpie page session can resume the currently running job.
        // No secrets are in progress events, and the endpoint still requires
        // the page's random capability.
        if (!s.job && activeJob?.state === "running") s.job = activeJob;
        else if (!s.job && recentJob && clock() - recentJob.started < 30 * 60 * 1000)
          s.job = recentJob;
        const job = s.job;
        if (!job) return json(res, 200, { state: "idle" });
        return json(res, 200, {
          id: job.id, state: job.state, mode: job.mode,
          total: job.total, done: job.done, added: job.added,
          reused: job.reused, failed: job.failed,
          result: job.result, message: job.message || "",
          providerConnected: job.providerConnected, providerCount: job.providerCount ?? null,
          events: job.events,
        });
      }
      if (route === "/api/cancel" && req.method === "POST") {
        if (s.job?.state !== "running") return deny(res, 409, "No import in progress");
        s.job.controller.abort();
        return json(res, 200, { cancelRequested: true });
      }
      if (route === "/api/accounts" && req.method === "GET") {
        const rows = await poolRead();
        let valid = 0, needsRenew = 0;
        const accounts = rows.map((a) => {
          const tokenState = a.accessToken ? accessTokenState(a.accessToken).state : "missing";
          if (tokenState === "unexpired_unverified") valid++;
          else needsRenew++;
          return {
            id: who(a.email),
            email: safeAccountName(a.email),
            slotLabel: formatAccountSlotLabel(a.email),
            slotTag: accountSlotTag(a.email),
            updatedAt: a.updatedAt || null,
            hasAccess: !!a.accessToken,
            tokenState,
          };
        });
        accountIds.clear();
        for (const a of rows) accountIds.set(who(a.email), a.email);
        return json(res, 200, {
          total: accounts.length,
          summary: { total: accounts.length, valid, needsRenew },
          accounts,
        });
      }
      if (route === "/api/accounts/refresh" && req.method === "POST") {
        if (activeJob?.state === "running")
          return deny(res, 409, "批量导入正在运行，请等待完成后再检测刷新");
        const input = await bodyJSON(req);
        const proxyCheck = validateProxyUrl(input?.proxy);
        if (proxyCheck.error) return deny(res, 400, proxyCheck.error);
        const rows = await poolRead();
        const rowById = new Map();
        for (const r of rows) {
          const id = who(r.email);
          accountIds.set(id, r.email);
          rowById.set(id, r);
        }
        let targets;
        if (input?.all === true) {
          targets = rows;
        } else if (typeof input?.id === "string" && input.id) {
          const target = rowById.get(input.id);
          if (!target) return deny(res, 404, "Account not found; refresh list");
          targets = [target];
        } else {
          return deny(res, 400, "请指定要检测刷新的账号");
        }
        const results = [];
        let valid = 0, renewed = 0, failed = 0;
        for (const row of targets) {
          const outcome = await refreshAccount(row, {
            proxy: proxyCheck.proxy,
            forceRenew: input?.force === true,
          });
          if (outcome?.status === "valid") valid++;
          else if (outcome?.status === "renewed") renewed++;
          else failed++;
          results.push({
            id: who(row.email),
            email: safeAccountName(row.email),
            ok: outcome?.ok === true,
            status: outcome?.status || "failed",
            renewed: outcome?.renewed === true,
            tokenState: outcome?.tokenState || null,
            reason: outcome?.reason ? String(outcome.reason).slice(0, 180) : "",
          });
        }
        let providerConnected = null;
        if ((renewed > 0 || valid > 0) && poolChange) {
          try {
            const sync = await poolChange();
            providerConnected = sync?.connected === true;
          } catch {
            providerConnected = null;
          }
        }
        return json(res, 200, {
          total: results.length,
          valid, renewed, failed,
          providerConnected,
          results,
        });
      }
      if (route === "/api/remove" && req.method === "POST") {
        const input = await bodyJSON(req);
        const email = accountIds.get(input?.id);
        if (!email) return deny(res, 404, "Account not found; refresh list");
        await poolRemove(email);
        accountIds.delete(input.id);
        // Removing the last account must sign out the linked provider too;
        // removing one of several must leave the pool connected.
        let providerConnected = null;
        let connectionError = false;
        if (poolChange) {
          try {
            const sync = await poolChange();
            providerConnected = sync?.connected === true;
          } catch {
            connectionError = true;
          }
        }
        return json(res, 200, { removed: true, providerConnected, connectionError });
      }
      return deny(res, 404, "Not found");
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 422;
      // Never relay raw upstream/FS exceptions: they may expose credentials.
      const message = err?.status ? err.message :
        route === "/api/preview" ? "TXT 校验失败；请检查文件格式、大小和账号数量" :
        "操作失败；请检查账号池文件权限或本地服务";
      json(res, status, { error: message });
    }
  });
  return {
    server, sessions,
    setOnPoolChange(callback) { poolChange = callback; },
    async stageDraft(file) {
      let source;
      try { source = await readFile(file, "utf8"); }
      catch { throw new Error("无法读取选中的 TXT 文件"); }
      const parsed = parse(source);
      const filename = basename(file);
      stagePendingDraft(source, { filename, parsed });
      return {
        filename,
        count: parsed.accounts.length,
        errors: parsed.errors.length,
        firstError: parsed.errors[0] || null,
      };
    },
    /**
     * Providers -> GPTFree calls an OS-native file dialog, then imports in
     * the plugin host. No web page is opened. The progress is visible in
     * the SAME Magpie sidebar GUI, through /api/status.
     *
     * The sign-in returns on FIRST successful account; the rest can keep
     * importing in the background. The hook never returns a credential.
     */
    async startNativeImport(file, { signal, mode = "pool", skipInvalid = false, onFirstAccount = null } = {}) {
      if (mode !== "pool") throw new Error("Providers 入口仅支持独立 Token 号池");
      if (activeJob?.state === "running") throw new Error("已有批量导入任务正在运行，请在左侧菜单「GPT号池」页面查看进度");
      // Validate before launching any browser or calling upstream.
      let source;
      try { source = await readFile(file, "utf8"); }
      catch { throw new Error("无法读取选中的 TXT 文件"); }
      const parsed = parse(source);
      const filename = basename(file);
      if (parsed.accounts.length === 0 || (parsed.errors.length > 0 && !skipInvalid)) {
        stagePendingDraft(source, { filename, parsed });
        const firstErr = parsed.errors[0];
        const detail = firstErr ? `（第 ${firstErr.line} 行：${firstErr.reason}）` : "";
        throw new Error(
          parsed.errors.length > 0
            ? `账号 TXT 格式不正确，共 ${parsed.errors.length} 行错误${detail}；已自动暂存到左侧菜单「GPT号池」文本框，打开即可编辑或跳过错误行导入`
            : "账号 TXT 格式无效或为空，已预加载到左侧菜单「GPT号池」文本框检查"
        );
      }
      pendingDraft = null;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) controller.abort();
      const job = {
        id: randomBytes(16).toString("hex"),
        state: "running", mode: "pool", started: clock(),
        total: parsed.accounts.length, done: 0, added: 0,
        reused: 0, failed: 0, events: [], eventSeq: 0,
        controller, result: null, providerConnected: null, providerCount: null,
      };
      activeJob = job;
      recentJob = job;
      let resolveFirst;
      const first = new Promise(resolve => { resolveFirst = resolve; });
      let settled = false;
      const settleFirst = (result) => {
        if (settled) return;
        settled = true;
        resolveFirst(result);
      };
      queueMicrotask(async () => {
        let syncChain = Promise.resolve();
        try {
          const answer = await batch({
            file, mode: "pool", consent: true, skipInvalid,
            signal: controller.signal, read: async () => source,
            onProgress: (event) => {
              if (job.state !== "running") return;
              if (["added", "token_reused", "failed"].includes(event.state)) job.done++;
              if (["added", "token_reused"].includes(event.state)) {
                job.added++;
                const slotTag = typeof event.slotTag === "string" ? event.slotTag : "";
                const label = typeof event.accountLabel === "string" ? event.accountLabel :
                  typeof event.email === "string" ? event.email : "";
                if (!settled) {
                  try { onFirstAccount?.({ slotTag, label }); } catch {}
                  // The provider can be signed in now; no second login step.
                  settleFirst({ ok: true, slotTag, label });
                } else if (parsed.accounts.length > 1 && poolChange) {
                  syncChain = syncChain.then(() => poolChange()).catch(() => {});
                }
              }
              if (event.state === "token_reused") job.reused++;
              if (event.state === "failed") job.failed++;
              job.events.push({ ...event, seq: ++job.eventSeq, at: clock() });
              if (job.events.length > 250) job.events.shift();
            },
          });
          await syncChain;
          job.result = {
            total: answer.total, added: answer.added, reused: answer.reused,
            failed: answer.failed?.length || 0, duplicates: answer.duplicates || 0,
            invalid: answer.invalid?.length || 0,
          };
          job.added = answer.added;
          job.reused = answer.reused;
          job.failed = answer.failed?.length || 0;
          if (answer.added > 0 && poolChange) {
            try {
              const linked = await poolChange();
              job.providerConnected = linked?.connected === true;
              job.providerCount = Number(linked?.count ?? answer.added);
            } catch { job.providerConnected = false; }
          }
          settleFirst(answer.added ? { ok: true } : {
            ok: false, error: "没有账号成功入池；请在左侧菜单「GPT号池」页面查看失败原因",
          });
          job.state = controller.signal.aborted ? "canceled" : "completed";
        } catch {
          await syncChain;
          if (job.added > 0 && poolChange) {
            try {
              const linked = await poolChange();
              job.providerConnected = linked?.connected === true;
              job.providerCount = Number(linked?.count ?? job.added);
            } catch {}
          }
          settleFirst({ ok: false, error: controller.signal.aborted ?
            "批量导入已取消" : "导入失败，请在左侧菜单「GPT号池」页面查看详情" });
          job.state = controller.signal.aborted ? "canceled" : "error";
          job.message = controller.signal.aborted ? "已取消" : "账号导入任务失败";
        } finally {
          signal?.removeEventListener("abort", onAbort);
          source = "";
          if (activeJob === job) activeJob = null;
        }
      });
      return { jobId: job.id, first, cancel: () => controller.abort() };
    },
    async listen() {
      // A non-loopback bind would expose password/TOTP import to the LAN.
      if (bind !== "127.0.0.1") throw new Error("GUI service can only bind 127.0.0.1");
      await new Promise((resolve, reject) => {
        const failed = (e) => { server.off("listening", resolve); reject(e); };
        server.once("error", failed);
        server.once("listening", () => { server.off("error", failed); resolve(); });
        server.listen(port, bind);
      });
      return server.address();
    },
    async close() {
      for (const s of sessions.values()) s.job?.controller?.abort();
      if (!server.listening) return;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

let activeService;
export async function startGuiServer({ port = GUI_PORT, onPoolChange = null } = {}) {
  if (activeService) {
    if (onPoolChange) activeService.setOnPoolChange(onPoolChange);
    return activeService;
  }
  const service = createGuiService({ port, onPoolChange });
  try { await service.listen(); }
  catch (err) {
    throw new Error("GPT号池 GUI service could not bind to 127.0.0.1:" + port + " (" +
      (err?.code === "EADDRINUSE" ? "port already in use" : "startup failure") + ")");
  }
  activeService = service;
  return service;
}
