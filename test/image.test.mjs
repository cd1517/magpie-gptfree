import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_BASE, discoverPoolModels, poolFetch } from "../lib/codex-pool.mjs";
import {
  IMAGE_MODEL_ID,
  buildImageModelCatalog,
  executeWebImageGeneration,
  parseImageRequest,
  runWebImageWorker,
} from "../lib/chatgpt-web-image.mjs";
import { accountSlotTag, buildSlotAuthBody } from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
function jwt(delta, email = "a@example.com") {
  return [
    Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
    Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + delta, email,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct123" },
    })).toString("base64url"),
    "signature",
  ].join(".");
}

function findPython() {
  for (const cmd of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    const res = spawnSync(cmd, ["-c", "import sys;print(sys.version_info.major)"], { encoding: "utf8" });
    if (res.status === 0 && String(res.stdout).trim() === "3") return cmd;
  }
  return null;
}

test("image model catalog exposes Magpie host.js @ai-sdk/openai-compatible schema and capabilities", async () => {
  const cat = buildImageModelCatalog(CODEX_BASE);
  const img = cat[IMAGE_MODEL_ID];
  assert.equal(img.id, "gpt-image-2");
  assert.equal(img.api.id, "gpt-image-2");
  assert.equal(img.api.url, CODEX_BASE);
  assert.equal(img.api.npm, "@ai-sdk/openai-compatible");
  assert.equal(img.capabilities.input.text, true);
  assert.equal(img.capabilities.input.image, true);
  assert.equal(img.capabilities.output.text, false);
  assert.equal(img.capabilities.output.image, true);
  assert.equal(img.attachment, true);

  // Verify integrated discoverPoolModels keeps Codex text models on @ai-sdk/openai
  const models = await discoverPoolModels({
    read: async () => [{ email: "free@example.com", password: "p", totp: seed, accessToken: jwt(3600, "free@example.com") }],
    fetcher: async () => new Response(JSON.stringify({
      models: [{ slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(models["gpt-5.6-luna"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-image-2"].api.npm, "@ai-sdk/openai-compatible");
});

test("TestModels chat/completions probe returns 400 pointing to Images API or Responses API", async () => {
  const imgProbe = await poolFetch(CODEX_BASE + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(imgProbe.status, 400);
  const imgJson = await imgProbe.json();
  assert.match(imgJson.error.message, /\/v1\/images\/generations/);
  assert.match(imgJson.error.message, /\/v1\/images\/edits/);

  const codexProbe = await poolFetch(CODEX_BASE + "/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(codexProbe.status, 400);
  const codexJson = await codexProbe.json();
  assert.match(codexJson.error.message, /\/v1\/responses/);
});

test("parseImageRequest parses both JSON generations and multipart/form-data edits with image[], mask, and markup", async () => {
  const gen = await parseImageRequest("/backend-api/codex/images/generations", JSON.stringify({
    model: "gpt-image-2",
    prompt: "a corgi in space",
    n: 2,
    size: "1024x1024",
    quality: "high",
    output_format: "webp",
    background: "transparent",
  }));
  assert.equal(gen.model, "gpt-image-2");
  assert.equal(gen.n, 2);
  assert.equal(gen.output_format, "webp");
  assert.equal(gen.background, "transparent");
  assert.deepEqual(gen.images, []);

  // Build real multipart/form-data payload using FormData + Response
  const fd = new FormData();
  fd.append("model", "gpt-image-2");
  fd.append("prompt", "add sunglasses");
  fd.append("n", "1");
  fd.append("image[]", new File([Buffer.from("png-bytes-1")], "photo.png", { type: "image/png" }));
  fd.append("mask", new File([Buffer.from("mask-bytes-1")], "mask.png", { type: "image/png" }));
  fd.append("markup", new File([Buffer.from("markup-bytes-1")], "markup.png", { type: "image/png" }));
  const multipartReq = new Request("https://chatgpt.com/backend-api/codex/images/edits", {
    method: "POST",
    body: fd,
  });
  const rawBuf = Buffer.from(await multipartReq.arrayBuffer());
  const contentType = multipartReq.headers.get("content-type");

  const edit = await parseImageRequest("/backend-api/codex/images/edits", rawBuf, { "content-type": contentType });
  assert.equal(edit.model, "gpt-image-2");
  assert.equal(edit.prompt, "add sunglasses");
  assert.equal(edit.images.length, 2);
  assert.equal(edit.images[0].filename, "photo.png");
  assert.equal(edit.images[1].filename, "markup.png");
  assert.equal(edit.masks.length, 1);
  assert.equal(edit.masks[0].filename, "mask.png");

  // Remote image URL in JSON edits is rejected with 400
  await assert.rejects(
    parseImageRequest("/backend-api/codex/images/edits", JSON.stringify({
      prompt: "edit",
      image: "https://attacker.invalid/secret.png",
    })),
    (err) => err.status === 400,
  );
});

test("poolFetch /images/generations supports 401 reauth, 429/502 failover, preferredSlot, and multiple images (n=2)", async () => {
  const accA = { email: "alpha@example.com", password: "p1", totp: seed, accessToken: jwt(3600, "alpha@example.com") };
  const accB = { email: "beta@example.com", password: "p2", totp: seed, accessToken: jwt(3600, "beta@example.com") };
  const renewedB = jwt(3600, "beta@example.com") + "2";
  const slotB = accountSlotTag(accB.email);

  const calls = [];
  let reauthCalls = 0;

  const res = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "cute orange cat", n: 2, size: "1024x1024" }),
  }, {
    read: async () => [accA, accB],
    preferredSlot: slotB,
    reauthenticate: async (account) => {
      reauthCalls++;
      return { ...account, accessToken: renewedB };
    },
    runWorker: async (payload) => {
      calls.push({ token: payload.access_token, prompt: payload.prompt });
      // accB initially 401 -> reauth -> renewedB succeeds; accA 429 -> failover to renewedB
      if (payload.access_token === accB.accessToken) {
        return { ok: false, http_status: 401, error_code: "unauthorized", error: "token expired" };
      }
      if (payload.access_token === accA.accessToken) {
        return { ok: false, http_status: 429, error_code: "rate_limited", error: "quota exceeded" };
      }
      return {
        ok: true,
        created: 1731150000,
        data: [{ b64_json: Buffer.from("fake-png").toString("base64"), media_type: "image/png", revised_prompt: payload.prompt }],
      };
    },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, 1731150000);
  assert.equal(body.data.length, 2);
  assert.equal(body.data[0].media_type, "image/png");
  assert(body.usage.input_tokens > 0);
  assert(body.usage.output_tokens >= 2048);
  assert.equal(reauthCalls, 1);
  // Preferred slot B tried first
  assert.equal(calls[0].token, accB.accessToken);
});

test("content policy refusal (400) stops immediately without burning remaining pooled accounts", async () => {
  const acc1 = { email: "a@example.com", password: "p", totp: seed, accessToken: jwt(3600, "a@example.com") };
  const acc2 = { email: "b@example.com", password: "p", totp: seed, accessToken: jwt(3600, "b@example.com") };
  let workerCalls = 0;

  const res = await poolFetch(CODEX_BASE + "/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "gpt-image-2", prompt: "blocked prompt" }),
  }, {
    read: async () => [acc1, acc2],
    runWorker: async () => {
      workerCalls++;
      return {
        ok: false,
        http_status: 400,
        error_code: "content_policy_violation",
        error: "Rejected by safety system",
      };
    },
  });

  assert.equal(res.status, 400);
  assert.equal(workerCalls, 1);
  const json = await res.json();
  assert.equal(json.error.code, "content_policy_violation");
});

test("GPTFreePoolPlugin loader wires poolSlot into poolFetch for /images/edits", async () => {
  const plug = await GPTFreePoolPlugin();
  const auth = buildSlotAuthBody("slot@example.com");
  const loaderOpts = await plug.auth.loader(async () => auth);
  assert.equal(loaderOpts.baseURL, CODEX_BASE);
  // Calling loader fetch with an invalid URL still goes through poolFetch validation
  await assert.rejects(loaderOpts.fetch("https://attacker.invalid/images/generations"), /only forwards/);
});

test("runWebImageWorker supports real Python IPC, Chinese UTF-8 payloads, and AbortSignal cancellation", {
  skip: !findPython(),
}, async () => {
  const pythonCmd = findPython();
  const tmp = await mkdtemp(join(tmpdir(), "gptfree-py-worker-"));
  try {
    // 1. Real image_worker.py clean JSON validation on missing prompt (with UTF-8 Chinese text)
    const badPromptRes = await runWebImageWorker(
      { action: "generate_image", access_token: "tok", prompt: "   " },
      { python: async () => pythonCmd },
    );
    assert.equal(badPromptRes.ok, false);
    assert.equal(badPromptRes.http_status, 400);

    // 2. AbortSignal immediately terminates a long-running Python worker process
    const sleepScript = join(tmp, "slow_worker.py");
    await writeFile(sleepScript, "import sys, time\ntime.sleep(30)\n", "utf8");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    await assert.rejects(
      runWebImageWorker(
        { action: "generate_image", prompt: "一只可爱的橘猫" },
        { python: async () => pythonCmd, workerPath: sleepScript, signal: ac.signal },
      ),
      (err) => err.name === "AbortError",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("executeWebImageGeneration stops rotating once maxTotalMs budget is exhausted", async () => {
  const accounts = [1, 2, 3, 4].map((n) => ({
    email: `u${n}@example.com`,
    password: "p",
    totp: seed,
    accessToken: jwt(3600, `u${n}@example.com`),
  }));
  let calls = 0;
  await assert.rejects(
    executeWebImageGeneration({
      accounts,
      request: { model: IMAGE_MODEL_ID, prompt: "cat", n: 1 },
      reauthenticate: async (a) => a,
      maxTotalMs: 20,
      runWorker: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 35));
        return { ok: false, http_status: 502, error_code: "upstream_error", error: "transient glitch" };
      },
    }),
    (err) => err.status === 503 && /transient glitch/.test(err.message),
  );
  assert.equal(calls, 1);
});
