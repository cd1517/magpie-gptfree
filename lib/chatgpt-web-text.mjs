import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { accessTokenState } from "./credentials.mjs";
import { workerPython } from "./dsh-http-auth.mjs";
import { accountSlotTag } from "./pool-connection.mjs";
import { sanitizeStatsMessage } from "./pool-stats.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEB_TEXT_WORKER = path.resolve(__dirname, "..", "python", "web_text_worker.py");

export const DEFAULT_WEB_TEXT_MODEL = "gpt-5.6-luna";

// Verified working on Free/Platform ChatGPT Web accounts (/backend-api/f/conversation).
// Excludes watermarked variants (e.g. *-wm) that return 403 on Web endpoints.
export const WEB_TEXT_MODEL_SPECS = Object.freeze([
  { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: false },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: false },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true },
  { id: "gpt-6", name: "GPT-6", reasoning: false },
  { id: "gpt-5-6", name: "GPT-5.6", reasoning: false },
  { id: "gpt-6-mini", name: "GPT-6 Mini", reasoning: false },
  { id: "gpt-5-6-mini", name: "GPT-5.6 Mini", reasoning: false },
  { id: "gpt-6-t-mini", name: "GPT-6 Thinking Mini", reasoning: true },
  { id: "gpt-5-6-t-mini", name: "GPT-5.6 Thinking Mini", reasoning: true },
  { id: "auto", name: "ChatGPT Auto", reasoning: false },
]);

const MAX_STDERR_BYTES = 16 * 1024;
const MAX_SLOW_FAILOVERS = 3;
const MAX_TOTAL_PROBE_MS = 120_000;
const DEFAULT_COOLDOWN_SECS = 60;
const MAX_COOLDOWN_ENTRIES = 1024;

// Process-local short-term rate-limit memory for text calls so 429'd accounts rotate cleanly
// without touching persistent imageQuota counters in pool-stats.json.
const textCooldownUntil = new Map();

export class WebTextHttpError extends Error {
  constructor(status, message, code = "upstream_error", retryAfter = null) {
    super(message);
    this.name = "WebTextHttpError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function clearTextCooldowns() {
  textCooldownUntil.clear();
}

function getSlotCooldownUntil(email) {
  const tag = accountSlotTag(email);
  if (!tag) return 0;
  const until = textCooldownUntil.get(tag) || 0;
  if (until && until <= Date.now()) {
    textCooldownUntil.delete(tag);
    return 0;
  }
  return until;
}

function setSlotCooldown(email, retryAfter) {
  const tag = accountSlotTag(email);
  if (!tag) return;
  const secs = Number(retryAfter);
  const waitMs = (Number.isFinite(secs) && secs > 0 ? Math.min(secs, 3600) : DEFAULT_COOLDOWN_SECS) * 1000;
  if (textCooldownUntil.size >= MAX_COOLDOWN_ENTRIES) {
    const oldestKey = textCooldownUntil.keys().next().value;
    if (oldestKey) textCooldownUntil.delete(oldestKey);
  }
  textCooldownUntil.set(tag, Date.now() + waitMs);
}

export function buildWebTextModelCatalog(baseURL) {
  const catalog = {};
  for (const spec of WEB_TEXT_MODEL_SPECS) {
    catalog[spec.id] = {
      id: spec.id,
      providerID: "gptfree-pool",
      name: spec.name,
      api: { id: spec.id, url: baseURL, npm: "@ai-sdk/openai" },
      status: "active",
      capabilities: {
        temperature: true,
        reasoning: spec.reasoning,
        attachment: false,
        toolcall: false,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 128000, output: 16384 },
      options: {},
      ...(spec.reasoning ? { variants: { low: {}, medium: {}, high: {} } } : {}),
    };
  }
  return catalog;
}

export function normalizeRequestedTextModel(model) {
  let raw = String(model || "").trim();
  if (raw.startsWith("gptfree-pool/")) {
    raw = raw.slice("gptfree-pool/".length).trim();
  }
  return raw || DEFAULT_WEB_TEXT_MODEL;
}

function normalizeThinkingEffort(effort) {
  const val = String(effort || "").trim().toLowerCase();
  if (!val || val === "none" || val === "minimal") return "";
  if (val === "max") return "xhigh";
  if (["low", "medium", "high", "xhigh"].includes(val)) return val;
  return "";
}

function extractMessageContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      if (part) parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const kind = String(part.type || "").toLowerCase();
    if (
      (kind === "input_text" || kind === "output_text" || kind === "text" || !kind)
      && typeof part.text === "string"
      && part.text
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function appendTextMessage(messages, role, content) {
  const text = String(content || "");
  if (!text.trim()) return;
  const normalizedRole = ["system", "developer", "user", "assistant"].includes(role)
    ? role
    : "user";
  const prev = messages[messages.length - 1];
  if (prev && prev.role === normalizedRole) {
    prev.content = `${prev.content}\n\n${text}`;
    return;
  }
  messages.push({ role: normalizedRole, content: text });
}

export function extractWebTextRequest(rawBody) {
  let parsed;
  try {
    parsed = typeof rawBody === "string" || Buffer.isBuffer(rawBody)
      ? JSON.parse(String(rawBody))
      : rawBody;
  } catch {
    throw new WebTextHttpError(400, "Invalid Responses request JSON", "invalid_request");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebTextHttpError(400, "Responses request body must be a JSON object", "invalid_request");
  }

  const requestedModel = String(parsed.model || DEFAULT_WEB_TEXT_MODEL).trim() || DEFAULT_WEB_TEXT_MODEL;
  const model = normalizeRequestedTextModel(requestedModel);
  const stream = parsed.stream === true;
  const thinkingEffort = normalizeThinkingEffort(
    parsed.reasoning?.effort ?? parsed.reasoning_effort ?? "",
  );

  const messages = [];
  const instructions = typeof parsed.instructions === "string" ? parsed.instructions.trim() : "";

  if (typeof parsed.input === "string") {
    appendTextMessage(messages, "user", parsed.input);
  } else if (Array.isArray(parsed.input)) {
    for (const item of parsed.input) {
      if (typeof item === "string") {
        appendTextMessage(messages, "user", item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const itemType = String(item.type || "").toLowerCase();
      if (itemType === "reasoning" || itemType === "item_reference") {
        continue;
      }
      if (itemType === "function_call") {
        const fnName = String(item.name || "tool");
        const fnArgs = typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});
        appendTextMessage(messages, "assistant", `[Tool Call: ${fnName}(${fnArgs})]`);
        continue;
      }
      if (itemType === "function_call_output") {
        const callId = String(item.call_id || "").trim();
        const outText = typeof item.output === "string"
          ? item.output
          : JSON.stringify(item.output ?? "");
        appendTextMessage(
          messages,
          "user",
          `[Tool Result${callId ? ` (${callId})` : ""}]:\n${outText}`,
        );
        continue;
      }
      const role = String(item.role || "user").toLowerCase();
      const text = extractMessageContentText(item.content);
      appendTextMessage(messages, role === "tool" ? "user" : role, text);
    }
  }

  if (instructions) {
    const first = messages[0];
    const hasSameSystem = first
      && (first.role === "system" || first.role === "developer")
      && first.content.trim() === instructions;
    if (!hasSameSystem) {
      messages.unshift({ role: "system", content: instructions });
    }
  }

  if (!messages.length) {
    throw new WebTextHttpError(400, "Request input must contain at least one non-empty message", "invalid_request");
  }

  let charCount = 0;
  for (const m of messages) charCount += m.content.length;

  return {
    model,
    requestedModel,
    stream,
    messages,
    thinkingEffort,
    estimatedInputTokens: Math.max(1, Math.ceil(charCount / 4)),
  };
}

function abortError() {
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

export async function runWebTextWorker(payload, {
  python = workerPython,
  signal,
  timeout = 180_000,
  workerPath = WEB_TEXT_WORKER,
  onDelta,
} = {}) {
  if (signal?.aborted) throw abortError();
  const command = await python();
  const serialized = JSON.stringify({ ...payload, stream_events: true });

  return new Promise((resolve, reject) => {
    const child = spawn(command, [workerPath, "--stream"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });

    let stdoutBuf = "";
    let stderr = "";
    let ended = false;
    let aborted = false;
    let finalResult = null;
    let errorResult = null;
    let accumulatedText = "";

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const finishErr = (err) => {
      if (ended) return;
      ended = true;
      cleanup();
      reject(err);
    };

    const finishOk = (value) => {
      if (ended) return;
      ended = true;
      cleanup();
      resolve(value);
    };

    const onAbort = () => {
      aborted = true;
      try { child.kill(); } catch {}
      finishErr(abortError());
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finishOk({
        ok: false,
        http_status: 504,
        error_code: "timeout",
        error: "Web text worker timed out",
      });
    }, timeout);

    const processLine = (rawLine) => {
      const line = String(rawLine || "").trim();
      if (!line) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.type === "delta" && typeof parsed.delta === "string" && parsed.delta) {
        accumulatedText += parsed.delta;
        try {
          onDelta?.(parsed.delta, parsed);
        } catch {}
        return;
      }
      if (parsed.type === "done" || parsed.ok === true) {
        finalResult = parsed;
        return;
      }
      if (parsed.type === "error" || parsed.ok === false) {
        errorResult = parsed;
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        processLine(line);
        idx = stdoutBuf.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += chunk.toString("utf-8").slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    child.on("error", (err) => {
      finishOk({
        ok: false,
        http_status: 502,
        error_code: "worker_spawn_failed",
        error: sanitizeStatsMessage(err.message) || "Failed to launch web text worker",
      });
    });

    child.on("close", (code) => {
      if (ended || aborted) return;
      if (stdoutBuf.trim()) {
        processLine(stdoutBuf);
        stdoutBuf = "";
      }
      if (errorResult) {
        finishOk(errorResult);
        return;
      }
      if (finalResult) {
        finishOk({
          ok: true,
          text: typeof finalResult.text === "string" ? finalResult.text : accumulatedText,
          conversation_id: finalResult.conversation_id || "",
          model: finalResult.model || payload.model || "",
        });
        return;
      }
      finishOk({
        ok: false,
        http_status: 502,
        error_code: "worker_failed",
        error: sanitizeStatsMessage(stderr) || `Web text worker exited with code ${code}`,
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.end(serialized, "utf-8");
  });
}

export function buildResponsesPayload({
  responseId,
  messageId,
  createdAt,
  requestedModel,
  text,
  inputTokens,
}) {
  const outputText = String(text || "");
  const outputTokens = outputText ? Math.max(1, Math.ceil(outputText.length / 4)) : 0;
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "completed",
    model: requestedModel,
    output: [
      {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    output_text: outputText,
    usage: {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: inputTokens + outputTokens,
    },
  };
}

function errorResponse(status, message, code = "upstream_error", retryAfter = null) {
  const headers = { "content-type": "application/json" };
  if (Number.isFinite(Number(retryAfter)) && Number(retryAfter) > 0) {
    headers["retry-after"] = String(Math.ceil(Number(retryAfter)));
  }
  return new Response(
    JSON.stringify({
      error: {
        message: String(message || "Upstream request failed"),
        type: status === 400 ? "invalid_request_error" : "api_error",
        code,
      },
    }),
    { status, headers },
  );
}

function shouldFailoverResult(res) {
  const status = Number(res?.http_status || 502);
  if ([401, 403, 408, 429, 500, 502, 503, 504].includes(status)) return true;
  if (res?.token_invalid) return true;
  return false;
}

function orderWebTextAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const now = Date.now();
  const readyFresh = [];
  const readyStale = [];
  const cooled = [];

  for (const acc of list) {
    if (!acc) continue;
    if (getSlotCooldownUntil(acc.email) > now) {
      cooled.push(acc);
      continue;
    }
    if (acc.accessToken && accessTokenState(acc.accessToken).state === "unexpired_unverified") {
      readyFresh.push(acc);
    } else {
      readyStale.push(acc);
    }
  }
  return [...readyFresh, ...readyStale, ...cooled];
}

function encodeSseFrame(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

export async function executeWebTextGeneration(rawBody, accounts, {
  reauthenticate,
  signal,
  worker = runWebTextWorker,
  proxy = "",
  maxSlowFailovers = MAX_SLOW_FAILOVERS,
  maxTotalMs = MAX_TOTAL_PROBE_MS,
} = {}) {
  let reqSpec;
  try {
    reqSpec = extractWebTextRequest(rawBody);
  } catch (err) {
    if (err instanceof WebTextHttpError) {
      return errorResponse(err.status, err.message, err.code);
    }
    return errorResponse(400, "Invalid Responses request JSON", "invalid_request");
  }

  const ordered = orderWebTextAccounts(accounts);
  if (!ordered.length) {
    return errorResponse(
      503,
      "GPT号池 没有可用账号，请先批量导入账号。",
      "pool_empty",
    );
  }

  const deadline = Date.now() + maxTotalMs;
  let slowFailovers = 0;
  let lastError = null;
  let sawRateLimit = false;
  let maxRetryAfter = null;

  const attemptAccount = (account, allowReauth) => new Promise((resolveOutcome) => {
    if (signal?.aborted) {
      resolveOutcome({ kind: "abort" });
      return;
    }

    const attemptAbort = new AbortController();
    const onCallerAbort = () => attemptAbort.abort();
    if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    const responseId = `resp_${crypto.randomUUID().replace(/-/g, "")}`;
    const messageId = `msg_${crypto.randomUUID().replace(/-/g, "")}`;
    const createdAt = Math.floor(Date.now() / 1000);

    let streamStarted = false;
    let streamClosed = false;
    let sseController = null;
    let seq = 0;
    let streamedText = "";
    const encoder = new TextEncoder();

    const cleanupSignal = () => {
      if (signal) signal.removeEventListener("abort", onCallerAbort);
    };

    const pushSse = (eventName, payload) => {
      if (!sseController || streamClosed) return;
      try {
        sseController.enqueue(encoder.encode(encodeSseFrame(eventName, payload)));
      } catch {}
    };

    const closeSse = () => {
      if (streamClosed) return;
      streamClosed = true;
      cleanupSignal();
      if (sseController) {
        try { sseController.close(); } catch {}
      }
    };

    const ensureStreamResponse = () => {
      if (streamStarted || !reqSpec.stream) return;
      streamStarted = true;

      const stream = new ReadableStream({
        start(controller) {
          sseController = controller;
          const inProgressResponse = {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: reqSpec.requestedModel,
            output: [],
          };
          pushSse("response.created", {
            type: "response.created",
            sequence_number: seq++,
            response: inProgressResponse,
          });
          pushSse("response.in_progress", {
            type: "response.in_progress",
            sequence_number: seq++,
            response: inProgressResponse,
          });
          pushSse("response.output_item.added", {
            type: "response.output_item.added",
            sequence_number: seq++,
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
          pushSse("response.content_part.added", {
            type: "response.content_part.added",
            sequence_number: seq++,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        },
        cancel() {
          streamClosed = true;
          attemptAbort.abort();
          cleanupSignal();
        },
      });

      resolveOutcome({
        kind: "response",
        response: new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        }),
      });
    };

    const workerPromise = worker(
      {
        access_token: account.accessToken,
        model: reqSpec.model,
        messages: reqSpec.messages,
        thinking_effort: reqSpec.thinkingEffort,
        proxy,
      },
      {
        signal: attemptAbort.signal,
        onDelta(delta) {
          if (!delta || streamClosed) return;
          streamedText += delta;
          if (!reqSpec.stream) return;
          ensureStreamResponse();
          pushSse("response.output_text.delta", {
            type: "response.output_text.delta",
            sequence_number: seq++,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta,
          });
        },
      },
    );

    workerPromise.then(
      (res) => {
        if (attemptAbort.signal.aborted && !streamStarted) {
          cleanupSignal();
          resolveOutcome({ kind: "abort" });
          return;
        }

        if (res?.ok) {
          const finalText = typeof res.text === "string" ? res.text : streamedText;
          if (!reqSpec.stream) {
            cleanupSignal();
            const jsonBody = buildResponsesPayload({
              responseId,
              messageId,
              createdAt,
              requestedModel: reqSpec.requestedModel,
              text: finalText,
              inputTokens: reqSpec.estimatedInputTokens,
            });
            resolveOutcome({
              kind: "response",
              response: new Response(JSON.stringify(jsonBody), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            });
            return;
          }

          ensureStreamResponse();
          if (finalText.length > streamedText.length && finalText.startsWith(streamedText)) {
            const remainder = finalText.slice(streamedText.length);
            if (remainder) {
              pushSse("response.output_text.delta", {
                type: "response.output_text.delta",
                sequence_number: seq++,
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: remainder,
              });
            }
          }

          const completedResponse = buildResponsesPayload({
            responseId,
            messageId,
            createdAt,
            requestedModel: reqSpec.requestedModel,
            text: finalText,
            inputTokens: reqSpec.estimatedInputTokens,
          });

          pushSse("response.output_text.done", {
            type: "response.output_text.done",
            sequence_number: seq++,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text: finalText,
          });
          pushSse("response.content_part.done", {
            type: "response.content_part.done",
            sequence_number: seq++,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: finalText, annotations: [] },
          });
          pushSse("response.output_item.done", {
            type: "response.output_item.done",
            sequence_number: seq++,
            output_index: 0,
            item: completedResponse.output[0],
          });
          pushSse("response.completed", {
            type: "response.completed",
            sequence_number: seq++,
            response: completedResponse,
          });
          closeSse();
          return;
        }

        const errStatus = Number(res?.http_status || 502);
        const errMsg = sanitizeStatsMessage(res?.error) || "Upstream text generation failed";
        const errCode = String(res?.error_code || "upstream_error");

        if (streamStarted) {
          pushSse("error", {
            type: "error",
            error: {
              message: errMsg,
              code: errCode,
              type: "api_error",
            },
          });
          closeSse();
          return;
        }

        cleanupSignal();
        resolveOutcome({
          kind: "retryable_or_fatal",
          allowReauth,
          result: {
            http_status: errStatus,
            error: errMsg,
            error_code: errCode,
            token_invalid: Boolean(res?.token_invalid || errStatus === 401),
            retry_after: res?.retry_after ?? null,
          },
        });
      },
      (err) => {
        cleanupSignal();
        if (err?.name === "AbortError") {
          if (streamStarted) {
            closeSse();
            return;
          }
          resolveOutcome({ kind: "abort" });
          return;
        }
        const errMsg = sanitizeStatsMessage(err?.message) || "Web text worker error";
        if (streamStarted) {
          pushSse("error", {
            type: "error",
            error: {
              message: errMsg,
              code: "worker_error",
              type: "api_error",
            },
          });
          closeSse();
          return;
        }
        resolveOutcome({
          kind: "retryable_or_fatal",
          allowReauth,
          result: {
            http_status: Number(err?.status || 502),
            error: errMsg,
            error_code: String(err?.code || "worker_error"),
            token_invalid: Number(err?.status) === 401,
            retry_after: err?.retryAfter ?? null,
          },
        });
      },
    );
  });

  for (const original of ordered) {
    if (signal?.aborted) {
      throw abortError();
    }
    if (Date.now() > deadline) {
      break;
    }

    let account = original;
    const staleOrMissing = !account.accessToken
      || accessTokenState(account.accessToken).state !== "unexpired_unverified";

    if (staleOrMissing) {
      if (slowFailovers >= maxSlowFailovers || typeof reauthenticate !== "function") {
        continue;
      }
      slowFailovers += 1;
      try {
        account = await reauthenticate(original);
      } catch (err) {
        lastError = {
          http_status: 401,
          error_code: "reauth_failed",
          error: sanitizeStatsMessage(err?.message) || "账号重新登录失败",
        };
        continue;
      }
    }

    let attemptedReauthForAccount = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!account?.accessToken) break;
      const outcome = await attemptAccount(account, attempt === 0 && !attemptedReauthForAccount);

      if (outcome.kind === "abort") {
        throw abortError();
      }
      if (outcome.kind === "response") {
        return outcome.response;
      }

      const res = outcome.result;
      lastError = res;
      const status = Number(res.http_status || 502);

      if (
        (status === 401 || res.token_invalid)
        && outcome.allowReauth
        && typeof reauthenticate === "function"
        && slowFailovers < maxSlowFailovers
      ) {
        slowFailovers += 1;
        attemptedReauthForAccount = true;
        try {
          account = await reauthenticate(account);
          continue;
        } catch (err) {
          lastError = {
            http_status: 401,
            error_code: "reauth_failed",
            error: sanitizeStatsMessage(err?.message) || res.error,
          };
          break;
        }
      }

      if (status === 429) {
        sawRateLimit = true;
        const retrySec = Number(res.retry_after);
        if (Number.isFinite(retrySec) && retrySec > 0) {
          maxRetryAfter = Math.max(maxRetryAfter || 0, Math.ceil(retrySec));
        }
        setSlotCooldown(account.email, retrySec);
      }

      if (!shouldFailoverResult(res)) {
        return errorResponse(status, res.error, res.error_code, res.retry_after);
      }
      break;
    }
  }

  if (sawRateLimit) {
    return errorResponse(
      429,
      lastError?.error || "所有 GPT号池 账号当前触发上游限流，请稍后再试或导入更多账号。",
      "rate_limit_exceeded",
      maxRetryAfter,
    );
  }
  const finalStatus = Number(lastError?.http_status || 503);
  return errorResponse(
    [400, 401, 403, 429, 500, 502, 503, 504].includes(finalStatus) ? finalStatus : 503,
    lastError?.error || "所有 GPT号池 账号均不可用；请检查后台 HTTP 登录、目标模型授权及账号权限。",
    lastError?.error_code || "pool_exhausted",
    lastError?.retry_after ?? null,
  );
}
