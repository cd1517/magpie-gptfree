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
import { join, dirname } from "node:path";
import { parseAccounts, safeAccountName, MAX_BYTES } from "./credentials.mjs";
import { runBatch } from "./importer.mjs";
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
  onPoolChange = null,
  clock = now, port = GUI_PORT, bind = "127.0.0.1",
} = {}) {
  const sessions = new Map();
  const accountIds = new Map();
  const idKey = randomBytes(32);
  let activeJob = null;
  function prune() {
    const t = clock();
    for (const [id, s] of sessions) {
      if (s.expires < t) {
        s.job?.controller?.abort();
        sessions.delete(id);
      } else if (s.draft && s.draft.expires < t) {
        s.draft = null;
      }
    }
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
    const uri = new URL(req.url || "/", "http://localhost");
    const route = uri.pathname;
    if (req.method === "OPTIONS") {
      if (origin !== "null") return deny(res);
      res.writeHead(204); res.end(); return;
    }
    if (origin && origin !== "null") return deny(res);
    if (route === "/ui" && req.method === "GET") {
      const id = openSession();
      const source = await readFile(join(root, "dashboard.html"), "utf8");
      const html = source.replace("__GPTFREE_SESSION__", id);
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
        (!req.headers["content-type"]?.startsWith("application/json") || origin !== "null"))
      return deny(res, 403, "Secure GUI request required");
    try {
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
        if (s.draft.invalid || !s.draft.count)
          return deny(res, 422, "Fix TXT validation errors before importing");
        if (data?.consent !== true) return deny(res, 403, "Account ownership confirmation required");
        if (!["native", "pool"].includes(data?.mode)) return deny(res, 400, "Invalid import mode");
        if (activeJob?.state === "running") return deny(res, 409, "Another import is running");
        const draft = s.draft;
        s.draft = null;
        const controller = new AbortController();
        const job = {
          id: randomBytes(16).toString("hex"),
          state: "running", mode: data.mode, started: clock(),
          total: draft.count, done: 0, added: 0, reused: 0,
          failed: 0, events: [], eventSeq: 0, controller, result: null,
          providerConnected: null,
        };
        activeJob = job;
        s.job = job;
        // Respond immediately. Account OAuth and browser work asynchronously.
        queueMicrotask(async () => {
          try {
            const answer = await batch({
              file: "gui-upload",
              read: async () => draft.source,
              mode: job.mode,
              consent: true,
              signal: controller.signal,
              onProgress: (event) => {
                if (job.state !== "running") return;
                if (["added", "token_reused", "failed"].includes(event.state)) job.done++;
                if (event.state === "added" || event.state === "token_reused") job.added++;
                if (event.state === "token_reused") job.reused++;
                if (event.state === "failed") job.failed++;
                job.events.push({ ...event, seq: ++job.eventSeq, at: clock() });
                if (job.events.length > 250) job.events.shift();
              },
            });
            job.result = {
              total: answer.total,
              added: answer.added, reused: answer.reused,
              failed: answer.failed?.length || 0,
              duplicates: answer.duplicates || 0,
            };
            job.added = answer.added;
            job.reused = answer.reused;
            job.failed = answer.failed?.length || 0;
            // Successful pool imports must automatically connect Magpie's
            // provider; native Codex imports must not alter this marker.
            if (job.mode === "pool" && answer.added > 0 && onPoolChange) {
              try {
                const updated = await onPoolChange();
                job.providerConnected = updated?.connected === true;
                if (!job.providerConnected)
                  job.message = "账号已导入，但 Magpie 本地号池暂未连接，请检查本地存储状态";
              } catch {
                job.providerConnected = false;
                job.message = "账号已入池，但 Magpie Provider 状态同步失败；请重新打开插件查看";
              }
            }
            job.state = controller.signal.aborted ? "canceled" : "completed";
          } catch {
            job.state = controller.signal.aborted ? "canceled" : "error";
            job.message = controller.signal.aborted ?
              "导入已取消" : "导入进程遇到错误；请检查本机 Magpie 与浏览器安装";
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
        const job = s.job;
        if (!job) return json(res, 200, { state: "idle" });
        return json(res, 200, {
          id: job.id, state: job.state, mode: job.mode,
          total: job.total, done: job.done, added: job.added,
          reused: job.reused, failed: job.failed,
          result: job.result, message: job.message || "",
          providerConnected: job.providerConnected, events: job.events,
        });
      }
      if (route === "/api/cancel" && req.method === "POST") {
        if (s.job?.state !== "running") return deny(res, 409, "No import in progress");
        s.job.controller.abort();
        return json(res, 200, { cancelRequested: true });
      }
      if (route === "/api/accounts" && req.method === "GET") {
        const rows = await poolRead();
        const accounts = rows.map((a, i) => ({
          id: who(a.email),
          email: safeAccountName(a.email),
          updatedAt: a.updatedAt || null,
          hasAccess: !!a.accessToken,
        }));
        accountIds.clear();
        for (const a of rows) accountIds.set(who(a.email), a.email);
        return json(res, 200, { total: accounts.length, accounts });
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
        if (onPoolChange) {
          try {
            const sync = await onPoolChange();
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
  if (activeService) return activeService;
  const service = createGuiService({ port, onPoolChange });
  try { await service.listen(); }
  catch (err) {
    throw new Error("GPTFree GUI service could not bind to 127.0.0.1:" + port + " (" +
      (err?.code === "EADDRINUSE" ? "port already in use" : "startup failure") + ")");
  }
  activeService = service;
  return service;
}
