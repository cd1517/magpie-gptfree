/**
 * Standalone temporary access-token pool for ChatGPT's Codex backend.
 * This does NOT modify Magpie's native Codex accounts, and does not
 * pretend that access-only tokens have a refresh token.
 *
 * An access token is only admitted after OpenAI's own /codex/models endpoint
 * returns a non-empty model list. JWT exp is just a preflight hint.
 */
import { accessTokenState } from "./credentials.mjs";
import { accountSlotTag } from "./pool-connection.mjs";
import { listPool, upsertPool } from "./pool-vault.mjs";
import { loginHTTPAccount } from "./dsh-http-auth.mjs";
import {
  ImageHttpError,
  buildImageModelCatalog,
  executeWebImageGeneration,
  isImageModelId,
  parseImageRequest,
} from "./chatgpt-web-image.mjs";

export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
export const CODEX_VERSION = "0.164.0";
const MODEL_URL = CODEX_BASE + "/models?client_version=" + encodeURIComponent(CODEX_VERSION);
const MODEL_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const modelPrompts = new Map();
const pendingAuth = new Map();
let nextIndex = 0;
let authQueue = Promise.resolve();

function accessClaims(token) {
  try {
    const payload = String(token).split(".")[1];
    if (!payload || payload.length > 65536) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch { return {}; }
}

function getAccountID(token) {
  const c = accessClaims(token);
  return c?.["https://api.openai.com/auth"]?.chatgpt_account_id ||
    c?.chatgpt_account_id || "";
}

function upstreamHeaders(token, accountID, streaming) {
  const h = new Headers({
    Authorization: "Bearer " + token,
    originator: "magpie_gptfree",
    "User-Agent": `MagpieGPTFree/${CODEX_VERSION}`,
    version: CODEX_VERSION,
    "OpenAI-Beta": "responses=experimental",
    Accept: streaming ? "text/event-stream" : "application/json",
  });
  if (accountID) h.set("chatgpt-account-id", accountID);
  if (streaming) h.set("Content-Type", "application/json");
  return h;
}

export function parseCodexCatalog(payload) {
  if (!Array.isArray(payload?.models)) throw new Error("Codex models response is invalid");
  const models = {};
  for (const item of payload.models.slice(0, 256)) {
    const id = item?.slug;
    if (typeof id !== "string" || !MODEL_ID.test(id) ||
        (item.visibility && item.visibility !== "list")) continue;
    const title = typeof item.display_name === "string" ? item.display_name : id;
    const prompt = item?.model_messages?.instructions_template || item?.base_instructions;
    if (typeof prompt === "string" && prompt.length <= 150000) modelPrompts.set(id, prompt);
    models[id] = {
      id, name: title,
      api: { id, url: CODEX_BASE, npm: "@ai-sdk/openai" },
      provider: { npm: "@ai-sdk/openai" },
      tool_call: true,
      limit: { context: Number(item.context_window) || 200000, output: 32000 },
    };
  }
  if (!Object.keys(models).length) throw new Error("Codex did not provide usable models");
  return models;
}

export async function verifyAccessToken(token, { fetcher = fetch, signal, expectedEmail = "" } = {}) {
  if (accessTokenState(token).state !== "unexpired_unverified")
    return { accepted: false, reason: "expired_or_unverified" };
  const claims = accessClaims(token);
  const who = String(claims.email || "").trim().toLowerCase();
  if (who && expectedEmail && who !== expectedEmail.trim().toLowerCase())
    return { accepted: false, reason: "identity_mismatch" };
  const h = upstreamHeaders(token, getAccountID(token), false);
  let response;
  try {
    response = await fetcher(MODEL_URL, {
      headers: h, method: "GET", redirect: "error",
      signal: signal || AbortSignal.timeout(15000),
    });
  } catch {
    return { accepted: false, reason: "network_error" };
  }
  if (!response.ok) return { accepted: false, reason: "status_" + response.status };
  try {
    const models = parseCodexCatalog(await response.json());
    return { accepted: true, models };
  } catch {
    return { accepted: false, reason: "invalid_catalog" };
  }
}

export function prepareCodexBody(raw) {
  let b;
  try { b = typeof raw === "string" ? JSON.parse(raw) : structuredClone(raw); }
  catch { throw new Error("Cannot decode Responses request body"); }
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw new Error("Responses request body is not an object");
  for (const key of [
    "max_output_tokens", "max_completion_tokens", "temperature", "top_p",
    "previous_response_id", "user", "safety_identifier", "prompt_cache_options",
  ]) delete b[key];
  if (!["priority", "ultrafast"].includes(b.service_tier)) delete b.service_tier;
  if (typeof b.input === "string")
    b.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: b.input }] }];
  if (!Array.isArray(b.input)) b.input = [];
  b.input = b.input.filter((item) => item?.type !== "item_reference").map((item) => {
    if (!item || typeof item !== "object") return item;
    const copy = { ...item };
    delete copy.id;
    if (["message", "reasoning"].includes(copy.type)) delete copy.status;
    if (copy.role === "system") copy.role = "developer";
    return copy;
  });
  const own = typeof b.instructions === "string" ? b.instructions.trim() : "";
  const standard = modelPrompts.get(b.model);
  if (standard && own && standard !== own) {
    b.input.unshift({
      type: "message", role: "developer",
      content: [{ type: "input_text", text: own }],
    });
    b.instructions = standard;
  } else if (standard) b.instructions = standard;
  b.store = false;
  b.stream = true;
  b.tool_choice = "auto";
  if (b.parallel_tool_calls === undefined) b.parallel_tool_calls = true;
  if (!b.text) b.text = { verbosity: "medium" };
  if (b.reasoning?.effort === "ultra") b.reasoning.effort = "max";
  if (b.reasoning?.effort !== "none") {
    if (b.reasoning && !b.reasoning.summary) b.reasoning.summary = "auto";
    if (!Array.isArray(b.include)) b.include = [];
    if (!b.include.includes("reasoning.encrypted_content"))
      b.include.push("reasoning.encrypted_content");
  }
  return JSON.stringify(b);
}

export async function renewAccount(account, {
  authenticate = loginHTTPAccount, verify = verifyAccessToken, save = upsertPool, proxy = "",
} = {}) {
  const prior = pendingAuth.get(account.email);
  if (prior) return prior;
  // DSH HTTP login uses isolated workers; serialize renewals to avoid a surge
  // of simultaneous reauthorization attempts.
  const task = authQueue.then(async () => {
    // Same standalone DSH HTTP path for initial login and token expiry/401.
    // No browser/GUI popup is started by automatic reauthentication.
    const { tokens } = await authenticate(account, proxy ? { proxy } : undefined);
    const verified = await verify(tokens.access, { expectedEmail: account.email });
    if (!verified.accepted)
      throw new Error("HTTP 登录返回的 Platform Token 不能用于当前 Magpie 模型接口");
    const record = { ...account, accessToken: tokens.access };
    await save(record);
    return record;
  });
  authQueue = task.catch(() => {});
  pendingAuth.set(account.email, task);
  try { return await task; }
  finally { pendingAuth.delete(account.email); }
}

async function candidate(account, { reauthenticate = renewAccount } = {}) {
  if (accessTokenState(account.accessToken).state === "unexpired_unverified")
    return account;
  return reauthenticate(account);
}

function orderAccountsForSlot(accounts, preferredSlot = "", rotate = false) {
  if (!Array.isArray(accounts) || !accounts.length) return [];
  if (typeof preferredSlot === "string" && preferredSlot) {
    const hit = accounts.findIndex((a) => typeof a?.email === "string" && accountSlotTag(a.email) === preferredSlot);
    if (hit >= 0) {
      const primary = accounts[hit];
      const others = accounts.filter((_, i) => i !== hit);
      if (rotate && others.length > 1) {
        const start = nextIndex++ % others.length;
        return [primary, ...others.slice(start), ...others.slice(0, start)];
      }
      return [primary, ...others];
    }
  }
  if (!rotate) return accounts.slice();
  const start = nextIndex++ % accounts.length;
  return [...accounts.slice(start), ...accounts.slice(0, start)];
}

export async function discoverPoolModels({
  read = listPool, fetcher = fetch, reauthenticate = renewAccount, preferredSlot = "",
} = {}) {
  const accounts = orderAccountsForSlot(await read(), preferredSlot, false);
  if (!accounts.length) return {};
  for (const account of accounts) {
    if (accessTokenState(account.accessToken).state !== "unexpired_unverified")
      continue;
    const probe = await verifyAccessToken(account.accessToken, { fetcher });
    if (probe.accepted) return { ...probe.models, ...buildImageModelCatalog(CODEX_BASE) };
  }
  for (const account of accounts) {
    try {
      if (reauthenticate === renewAccount) {
        let models = null;
        await renewAccount(account, {
          verify: async (token, opts) => {
            const res = await verifyAccessToken(token, { ...opts, fetcher });
            if (res.accepted) models = res.models;
            return res;
          },
        });
        if (models) return { ...models, ...buildImageModelCatalog(CODEX_BASE) };
      } else {
        const renewed = await reauthenticate(account);
        if (renewed?.accessToken) {
          const probe = await verifyAccessToken(renewed.accessToken, { fetcher });
          if (probe.accepted) return { ...probe.models, ...buildImageModelCatalog(CODEX_BASE) };
        }
      }
    } catch {
      // Try the next pooled account before giving up on discovery.
    }
  }
  return {};
}

export async function refreshPoolAccount(account, {
  fetcher = fetch, verify = verifyAccessToken, reauthenticate = renewAccount,
  proxy = "", forceRenew = false,
} = {}) {
  if (!account || typeof account.email !== "string")
    return { ok: false, status: "failed", renewed: false, reason: "账号记录无效" };
  try {
    if (!forceRenew && accessTokenState(account.accessToken).state === "unexpired_unverified") {
      const probe = await verify(account.accessToken, { fetcher, expectedEmail: account.email });
      if (probe.accepted) {
        return {
          ok: true,
          status: "valid",
          renewed: false,
          tokenState: "unexpired_unverified",
          modelCount: Object.keys(probe.models || {}).length,
        };
      }
    }
    const updated = await reauthenticate(account, { proxy });
    return {
      ok: true,
      status: "renewed",
      renewed: true,
      tokenState: accessTokenState(updated?.accessToken || "").state,
    };
  } catch (err) {
    const message = String(err?.message || "");
    const known = /DSH HTTP|Platform Token|没有返回可用|未找到可用 Python|HTTP 登录|认证后端|不能用于当前 Magpie/.test(message);
    const reason = known ? message.slice(0, 180) :
      "检测或刷新授权失败；请检查账号、TOTP、网络或代理";
    return { ok: false, status: "failed", renewed: false, reason };
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handleChatProbe(rawBody) {
  let model = "";
  try {
    const text = rawBody instanceof Uint8Array ? Buffer.from(rawBody).toString("utf8") :
      rawBody instanceof ArrayBuffer ? Buffer.from(rawBody).toString("utf8") :
      String(rawBody || "");
    const parsed = text ? JSON.parse(text) : {};
    model = String(parsed?.model || "").trim();
  } catch {}
  if (isImageModelId(model)) {
    return jsonResponse({
      error: {
        message: "This image model does not support /v1/chat/completions; use /v1/images/generations or /v1/images/edits instead.",
        type: "invalid_request_error",
      },
    }, 400);
  }
  return jsonResponse({
    error: {
      message: "Codex models on this provider require /v1/responses instead of /v1/chat/completions.",
      type: "invalid_request_error",
    },
  }, 400);
}

export async function poolFetch(input, init, {
  read = listPool, fetcher = fetch, reauthenticate = renewAccount, preferredSlot = "",
  runWorker, proxy = "",
} = {}) {
  let dest;
  try { dest = new URL(String(input)); }
  catch { throw new Error("Invalid Magpie request URL"); }
  if (dest.origin !== "https://chatgpt.com" || dest.username || dest.password || dest.hash)
    throw new Error("GPTFree plugin only forwards Codex /responses and /images endpoints");

  if (dest.pathname === "/backend-api/codex/chat/completions") {
    return handleChatProbe(init?.body);
  }

  if (dest.pathname === "/backend-api/codex/images/generations" ||
      dest.pathname === "/backend-api/codex/images/edits") {
    let parsedReq;
    try {
      parsedReq = await parseImageRequest(dest.pathname, init?.body, init?.headers);
    } catch (err) {
      if (err instanceof ImageHttpError) {
        return jsonResponse({
          error: {
            message: err.message,
            type: "invalid_request_error",
            ...(err.code ? { code: err.code } : {}),
          },
        }, err.status);
      }
      return jsonResponse({ error: { message: "Invalid image request", type: "invalid_request_error" } }, 400);
    }

    const accounts = await read();
    if (!accounts.length) {
      return jsonResponse({ error: { message: "GPTFree pool is empty; import accounts first" } }, 503);
    }
    const ordered = orderAccountsForSlot(accounts, preferredSlot, true);
    try {
      const result = await executeWebImageGeneration({
        accounts: ordered,
        request: parsedReq,
        signal: init?.signal,
        reauthenticate,
        ...(runWorker ? { runWorker } : {}),
        proxy,
      });
      return jsonResponse(result, 200);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (err instanceof ImageHttpError) {
        return jsonResponse({
          error: {
            message: err.message,
            type: err.status === 400 ? "invalid_request_error" : "server_error",
            ...(err.code ? { code: err.code } : {}),
          },
        }, err.status);
      }
      return jsonResponse({ error: { message: "Image generation failed", type: "server_error" } }, 503);
    }
  }

  if (dest.pathname !== "/backend-api/codex/responses")
    throw new Error("GPTFree plugin only forwards Codex /responses and /images endpoints");
  let body;
  try { body = prepareCodexBody(init?.body); }
  catch { return new Response('{"error":{"message":"Invalid Responses request"}}', { status: 400, headers: { "content-type": "application/json" } }); }
  const accounts = await read();
  if (!accounts.length) return new Response('{"error":{"message":"GPTFree pool is empty; import accounts first"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
  const ordered = orderAccountsForSlot(accounts, preferredSlot, true);
  for (const original of ordered) {
    let account;
    try { account = await candidate(original, { reauthenticate }); }
    catch { continue; }
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = upstreamHeaders(account.accessToken, getAccountID(account.accessToken), true);
      const key = JSON.parse(body)?.prompt_cache_key;
      if (typeof key === "string" && key.length < 256) {
        headers.set("session-id", key);
        headers.set("thread-id", key);
      }
      let r;
      try {
        r = await fetcher(CODEX_BASE + "/responses", {
          method: "POST", body, headers, redirect: "error", signal: init?.signal,
        });
      } catch { break; }
      if (r.ok) return r;
      if (r.status === 401 && attempt === 0) {
        try { account = await reauthenticate(account); continue; }
        catch { break; }
      }
      if (![401, 429, 500, 502, 503, 504].includes(r.status)) return r;
      break;
    }
  }
  return new Response('{"error":{"message":"所有 GPT号池 账号均不可用；请检查后台 HTTP 登录、目标模型授权及账号权限。"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
}
