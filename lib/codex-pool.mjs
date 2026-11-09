/**
 * Standalone temporary access-token pool for ChatGPT's Codex backend.
 * This does NOT modify Magpie's native Codex accounts, and does not
 * pretend that access-only tokens have a refresh token.
 *
 * An access token is only admitted after OpenAI's own /codex/models endpoint
 * returns a non-empty model list. JWT exp is just a preflight hint.
 */
import { accessTokenState } from "./credentials.mjs";
import { listPool, upsertPool } from "./pool-vault.mjs";
import { launchBrowser, loginAccount } from "./login.mjs";

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
    originator: "codex_cli_rs",
    "User-Agent": `codex_cli_rs/${CODEX_VERSION} (Magpie GPTFree plugin)`,
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

async function renewAccount(account) {
  const prior = pendingAuth.get(account.email);
  if (prior) return prior;
  // All visible OAuth logins share localhost:1455; serialize refresh across
  // DIFFERENT accounts too, not only repeated calls for the same account.
  const task = authQueue.then(async () => {
    const browser = await launchBrowser();
    try {
      const { tokens } = await loginAccount(account, { browser });
      const verified = await verifyAccessToken(tokens.access, { expectedEmail: account.email });
      if (!verified.accepted) throw new Error("New Codex sign-in has no usable models");
      const record = { ...account, accessToken: tokens.access };
      await upsertPool(record);
      return record;
    } finally { await browser.close(); }
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

export async function discoverPoolModels({ read = listPool, fetcher = fetch } = {}) {
  const accounts = await read();
  if (!accounts.length) return {};
  for (const account of accounts) {
    if (accessTokenState(account.accessToken).state !== "unexpired_unverified")
      continue;
    const probe = await verifyAccessToken(account.accessToken, { fetcher });
    if (probe.accepted) return probe.models;
  }
  return {};
}

export async function poolFetch(input, init, {
  read = listPool, fetcher = fetch, reauthenticate = renewAccount,
} = {}) {
  let dest;
  try { dest = new URL(String(input)); }
  catch { throw new Error("Invalid Magpie request URL"); }
  if (dest.origin !== "https://chatgpt.com" ||
      dest.pathname !== "/backend-api/codex/responses" ||
      dest.username || dest.password || dest.hash)
    throw new Error("GPTFree plugin only forwards Codex /responses");
  let body;
  try { body = prepareCodexBody(init?.body); }
  catch { return new Response('{"error":{"message":"Invalid Responses request"}}', { status: 400, headers: { "content-type": "application/json" } }); }
  const accounts = await read();
  if (!accounts.length) return new Response('{"error":{"message":"GPTFree pool is empty; import accounts first"}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
  const idx = nextIndex++ % accounts.length;
  for (let i = 0; i < accounts.length; i++) {
    const original = accounts[(idx + i) % accounts.length];
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
  return new Response('{"error":{"message":"All GPTFree pool accounts are unavailable. Check browser sign-in and account permissions."}}', {
    status: 503, headers: { "content-type": "application/json" },
  });
}
