import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuiService, GUI_PORT } from "../lib/gui-service.mjs";
import { readFile } from "node:fs/promises";
import { GPTFreeGuiPlugin } from "../index.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const future = () => [
  Buffer.from('{"alg":"RS256"}').toString("base64url"),
  Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 3600 })).toString("base64url"),
  "signature",
].join(".");

async function harness(options = {}) {
  const service = createGuiService({ port: 0, ...options });
  const addr = await service.listen();
  const base = "http://127.0.0.1:" + addr.port + "/";
  const entry = await fetch(base + "ui");
  assert.equal(entry.status, 200);
  const html = await entry.text();
  const token = html.match(/meta name="gptfree-session" content="([0-9a-f]{64})"/)?.[1];
  assert(token, "server creates an unpredictable page-session capability");
  const api = async (route, body, { bearer = token, origin = "null", contentType = true } = {}) => {
    const headers = { Origin: origin, "X-GPTFree-Session": bearer };
    if (body !== undefined && contentType) headers["Content-Type"] = "application/json";
    const r = await fetch(base + "api/" + route, {
      method: body === undefined ? "GET" : "POST", headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };
  return { service, base, html, token, api, close: async () => service.close() };
}

test("Magpie GUI manifest points to a real page and a loopback service", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.magpie.page.file, "gui/entry.html");
  assert.equal(pkg.magpie.page.service.port, GUI_PORT);
  assert(pkg.files.includes("gui"));
  assert.equal(typeof GPTFreeGuiPlugin, "function");
  const page = await readFile(new URL("../gui/entry.html", import.meta.url), "utf8");
  const entry = await readFile(new URL("../gui/entry.js", import.meta.url), "utf8");
  assert(page.includes("_magpie/bridge.js"));
  assert(entry.includes("magpie.service"));
  assert(entry.includes("location.replace"));
});

test("GUI serves a real page plus assets without exposing secrets", async () => {
  const h = await harness();
  try {
    assert(h.html.includes("选择账号文件"));
    assert(h.html.includes("开始批量导入"));
    assert(!h.html.includes(seed));
    assert(h.html.includes("gptfree-session"));
    const asset = await fetch(h.base + "assets/app.js");
    assert.equal(asset.status, 200);
    assert((await asset.text()).includes("fileInput"));
    assert(!h.html.includes("localStorage"));
  } finally { await h.close(); }
});

test("TXT upload parses 3 formats with masked rows, not passwords, TOTP or Token", async () => {
  const h = await harness();
  const jwt = future();
  const secretLink = "https://mail.example.store/verysecret123";
  const txt = [
    `user1@example.com----supersecret1----${seed}`,
    `user2@example.com---supersecret2---${seed}---${secretLink}`,
    `user3@example.com----supersecret3----${seed}----${jwt}`,
    `USER1@example.com----other-secret----${seed}`,
  ].join("\n");
  try {
    const { status, json } = await h.api("preview", { text: txt });
    assert.equal(status, 200);
    assert.equal(json.count, 3);
    assert.equal(json.duplicates, 1);
    assert.deepEqual(json.rows.map((row) => row.format), ["standard", "mail_link", "access_token"]);
    assert.equal(json.rows[2].tokenState, "unexpired_unverified");
    for (const value of [seed, jwt, secretLink, "supersecret", "user3@example.com"])
      assert(!JSON.stringify(json).includes(value), "secret included: " + value.slice(0, 4));
  } finally { await h.close(); }
});

test("GUI requires its page capability and Origin null to reach sensitive endpoints", async () => {
  const h = await harness();
  try {
    assert.equal((await h.api("accounts", undefined, { bearer: "0".repeat(64) })).status, 403);
    assert.equal((await h.api("accounts", undefined, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await h.api("preview", { text: "test@example.com----pass" }, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await h.api("preview", { text: "test@example.com----pass" }, { contentType: false })).status, 403);
    const invalid = await h.api("start", { mode: "pool", consent: true });
    assert.equal(invalid.status, 410);
    const preflight = await fetch(h.base + "api/preview", {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "X-GPTFree-Session, Content-Type" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "null");
  } finally { await h.close(); }
});

test("GUI rejects a draft with validation errors and requires explicit account ownership", async () => {
  const h = await harness();
  try {
    const txt = `bad-email----pw----${seed}\nuser@example.com----pw----${seed}`;
    const preview = await h.api("preview", { text: txt });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.errors.length, 1);
    assert.equal((await h.api("start", { mode: "pool", consent: true })).status, 422);
    const fixed = await h.api("preview", { text: `user@example.com----pw----${seed}` });
    assert.equal(fixed.status, 200);
    assert.equal((await h.api("start", { mode: "pool", consent: false })).status, 403);
  } finally { await h.close(); }
});

test("GUI starts a background batch, polls progress and never writes raw TXT to HTML response", async () => {
  let requestMode, seenRaw, runs = 0;
  const h = await harness({
    batch: async (args) => {
      runs++;
      requestMode = args.mode;
      seenRaw = await args.read();
      args.onProgress({ state: "authorizing", line: 1, email: "us***@example.com" });
      args.onProgress({ state: "token_reused", line: 1, email: "us***@example.com" });
      return { total: 1, added: 1, reused: 1, failed: [], duplicates: 0 };
    },
    poolRead: async () => [],
  });
  try {
    const txt = `user@example.com----super-secret-password----${seed}----${future()}`;
    await h.api("preview", { text: txt });
    const started = await h.api("start", { mode: "pool", consent: true });
    assert.equal(started.status, 202);
    assert.equal(started.json.state, "running");
    let state;
    for (let i = 0; i < 20; i++) {
      state = (await h.api("status")).json;
      if (state.state === "completed") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(state.state, "completed");
    assert.equal(state.result.added, 1);
    assert.equal(state.result.reused, 1);
    assert.equal(state.events.at(-1).state, "token_reused");
    assert.equal(runs, 1);
    assert.equal(requestMode, "pool");
    assert.equal(seenRaw, txt);
    for (const value of ["super-secret-password", seed, future().slice(0, 10)]) {
      assert(!JSON.stringify(state).includes(value));
      assert(!JSON.stringify(started.json).includes(value));
    }
  } finally { await h.close(); }
});

test("GUI cancel aborts an import without disclosing sensitive data", async () => {
  let observedAbort = false;
  const h = await harness({
    batch: async (args) => {
      await new Promise((resolve) => {
        if (args.signal.aborted) { observedAbort = true; resolve(); return; }
        args.signal.addEventListener("abort", () => { observedAbort = true; resolve(); }, { once: true });
      });
      throw new Error("token: sensitive error must not leak");
    },
  });
  try {
    await h.api("preview", { text: `user@example.com----secret----${seed}` });
    assert.equal((await h.api("start", { mode: "pool", consent: true })).status, 202);
    assert.equal((await h.api("cancel", {})).status, 200);
    let state;
    for (let i = 0; i < 20; i++) {
      state = (await h.api("status")).json;
      if (state.state === "canceled") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(observedAbort, true);
    assert.equal(state.state, "canceled");
    assert(!JSON.stringify(state).includes("sensitive"));
  } finally { await h.close(); }
});

test("GUI lists and removes accounts using opaque ids, not raw emails or tokens", async () => {
  const records = [{ email: "alice@example.com", accessToken: future(), totp: seed, password: "s" }];
  let removed;
  const h = await harness({
    poolRead: async () => records,
    poolRemove: async (email) => { removed = email; },
  });
  try {
    const listed = await h.api("accounts");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.total, 1);
    assert.equal(listed.json.accounts[0].email, "al***@example.com");
    const opaque = listed.json.accounts[0].id;
    assert.match(opaque, /^[a-f0-9]{32}$/);
    assert(!JSON.stringify(listed.json).includes("alice@example.com"));
    assert(!JSON.stringify(listed.json).includes(records[0].accessToken));
    assert.equal((await h.api("remove", { id: opaque })).status, 200);
    assert.equal(removed, "alice@example.com");
    assert.equal((await h.api("remove", { id: opaque })).status, 404);
  } finally { await h.close(); }
});

test("GUI is restricted to loopback, never LAN-exposed", async () => {
  const bad = createGuiService({ port: 0, bind: "0.0.0.0" });
  await assert.rejects(bad.listen(), /127.0.0.1/);
});
