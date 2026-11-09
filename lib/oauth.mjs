import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE = "https://auth.openai.com/oauth/authorize";
const TOKEN = "https://auth.openai.com/oauth/token";
const REDIRECT = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

export function makePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  return { verifier, challenge, state };
}

export function authorizationURL({ challenge, state, email }) {
  const q = new URLSearchParams({
    client_id: CODEX_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });
  if (email) q.set("login_hint", email);
  return AUTHORIZE + "?" + q.toString();
}

export async function startCallback({ state, timeoutMs = 180000, signal } = {}) {
  if (!state) throw new Error("缺少 OAuth state");
  let resolve, reject;
  let finished = false;
  const result = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Attach immediately: a callback rejection may happen before the browser has
  // navigated and begun awaiting wait(); do not trigger unhandledRejection.
  result.catch(() => {});
  const server = createServer((req, reply) => {
    const url = new URL(req.url || "/", REDIRECT);
    reply.setHeader("Content-Type", "text/html; charset=utf-8");
    reply.setHeader("Cache-Control", "no-store");
    reply.setHeader("Referrer-Policy", "no-referrer");
    if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) {
      reply.writeHead(400); reply.end("Not this sign-in."); return;
    }
    if (finished) { reply.writeHead(409); reply.end("Already processed."); return; }
    finished = true;
    const code = url.searchParams.get("code");
    const denied = url.searchParams.get("error");
    if (denied || !code) {
      reply.writeHead(400); reply.end("Authorization refused. Close this page.");
      reject(new Error("ChatGPT 未完成 OAuth 授权"));
      return;
    }
    reply.writeHead(200);
    reply.end("<h3>账号授权完成，可以关闭此窗口。</h3>");
    resolve(code);
  });
  server.on("clientError", (err, socket) => socket.destroy());
  try {
    server.listen(1455, "127.0.0.1");
    await once(server, "listening");
  } catch {
    try { server.close(); } catch {}
    throw new Error("本地 1455 端口不可用：请关闭其他 Codex 登录进程后再试");
  }
  const finish = (reason) => {
    if (finished) return;
    finished = true;
    reject(reason instanceof Error ? reason : new Error(String(reason)));
  };
  const timer = setTimeout(() => finish(new Error("OAuth 登录超时：该账号需要人工确认或重新登录")), timeoutMs);
  timer.unref?.();
  const aborted = () => finish(new Error("OAuth 登录已取消"));
  signal?.addEventListener("abort", aborted, { once: true });
  return {
    url: REDIRECT,
    wait: () => result,
    close: async () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (!finished) finish(new Error("OAuth 回调已关闭"));
      await new Promise((done) => server.close(() => done()));
    },
  };
}

export function decodeClaims(jwt) {
  try {
    const part = String(jwt).split(".")[1];
    if (!part || part.length > 65536) return {};
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : {};
  } catch { return {}; }
}

export async function exchangeCode(code, verifier, { fetcher = fetch, signal } = {}) {
  if (!code || !verifier) throw new Error("缺少授权码或 PKCE verifier");
  const form = new URLSearchParams({
    grant_type: "authorization_code", code, client_id: CODEX_CLIENT_ID,
    code_verifier: verifier, redirect_uri: REDIRECT,
  });
  let reply;
  try {
    reply = await fetcher(TOKEN, {
      method: "POST", redirect: "error", signal: signal || AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
  } catch {
    throw new Error("OAuth Token 交换网络失败，请检查 HTTPS 连接或代理");
  }
  if (!reply.ok) throw new Error("OAuth Token 交换失败 (HTTP " + reply.status + ")");
  let obj;
  try { obj = await reply.json(); }
  catch { throw new Error("OAuth Token 响应不是有效 JSON"); }
  if (!obj?.access_token || !obj?.refresh_token || !obj?.id_token)
    throw new Error("OAuth 未返回完整的 Codex access/refresh/id token");
  return { access: obj.access_token, refresh: obj.refresh_token, id: obj.id_token };
}

export function codexAuthJSON(tokens) {
  const claims = decodeClaims(tokens.id);
  const accountID = claims["https://api.openai.com/auth"]?.chatgpt_account_id || "";
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    tokens: {
      id_token: tokens.id,
      access_token: tokens.access,
      refresh_token: tokens.refresh,
      account_id: accountID,
    },
    last_refresh: new Date().toISOString(),
  };
}

export function signedInEmail(tokens) {
  const a = decodeClaims(tokens.id), b = decodeClaims(tokens.access);
  return String(a.email || b.email || "").trim().toLowerCase();
}
