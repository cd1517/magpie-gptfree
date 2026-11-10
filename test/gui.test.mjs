import assert from "node:assert/strict";
import { test } from "node:test";
import { createGuiService, GUI_PORT } from "../lib/gui-service.mjs";
import { createInMemoryStatsStore, recordImageCall, recordQuotaCheck } from "../lib/pool-stats.mjs";
import { accountSlotTag, formatAccountSlotLabel } from "../lib/pool-connection.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("Magpie GUI manifest points to a real page, provider menu action and a loopback service", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.magpie.name, "GPT号池");
  assert.equal(pkg.magpie.page.title, "GPT号池");
  assert.equal(pkg.magpie.page.titles.zh, "GPT号池");
  assert.equal(pkg.magpie.page.file, "gui/entry.html");
  assert.equal(pkg.magpie.page.service.port, GUI_PORT);
  assert.equal(pkg.magpie.actions[0].id, "batch-import");
  assert.equal(pkg.magpie.actions[0].menu, "provider");
  assert.equal(pkg.magpie.actions[0].titles.zh, "打开 GPT号池");
  assert(pkg.files.includes("gui"));
  assert.equal(typeof GPTFreeGuiPlugin, "function");
  const page = await readFile(new URL("../gui/entry.html", import.meta.url), "utf8");
  const entry = await readFile(new URL("../gui/entry.js", import.meta.url), "utf8");
  assert(page.includes("GPT号池"));
  assert(page.includes("_magpie/bridge.js"));
  assert(entry.includes("magpie.service"));
  assert(entry.includes("location.replace"));
});

test("GUI serves a real page with editable TXT-to-textarea flow and no secrets or storage", async () => {
  const h = await harness();
  try {
    assert(h.html.includes("GPT号池"));
    assert(h.html.includes("批量导入账号"));
    assert(h.html.includes("导入并授权入池"));
    assert(h.html.includes("skipInvalid"));
    assert(h.html.includes("proxyInput"));
    assert(h.html.includes("clearPaste"));
    assert(h.html.includes("refreshAllPool"));
    assert(h.html.includes("syncProviders"));
    assert(!h.html.includes(seed));
    assert(h.html.includes("gptfree-session"));
    const asset = await fetch(h.base + "assets/app.js");
    assert.equal(asset.status, 200);
    const app = await asset.text();
    assert(app.includes("fileInput"));
    assert(app.includes("pasteAccounts"));
    assert(app.includes("checkPaste"));
    assert(app.includes('$("pasteAccounts").value = text'));
    assert(!app.includes('$("pasteAccounts").value = ""') || app.includes("clearPaste"));
    assert(app.includes("accounts/refresh"));
    assert(app.includes("syncProviders"));
    assert(app.includes('api("draft")'));
    assert(app.includes('api("sync"'));
    assert(!h.html.includes("localStorage"));
    assert(!app.includes("localStorage"));
  } finally { await h.close(); }
});

test("TXT upload parses 3 and 5-col formats with masked rows, not passwords, TOTP or Token", async () => {
  const h = await harness();
  const jwt = future();
  const secretLink = "https://mail.example.store/verysecret123";
  const txt = [
    `user1@example.com----supersecret1----${seed}`,
    `user2@example.com---supersecret2---${seed}---${secretLink}`,
    `user3@example.com----supersecret3----${seed}----${jwt}`,
    `user4@example.com----supersecret4----${seed}----${jwt}----rt_never_leaked`,
    `USER1@example.com----other-secret----${seed}`,
  ].join("\n");
  try {
    const { status, json } = await h.api("preview", { text: txt });
    assert.equal(status, 200);
    assert.equal(json.count, 4);
    assert.equal(json.duplicates, 1);
    assert.deepEqual(json.rows.map((row) => row.format), ["standard", "mail_link", "access_token", "access_token"]);
    assert.equal(json.rows[2].tokenState, "unexpired_unverified");
    for (const value of [seed, jwt, secretLink, "supersecret", "user3@example.com", "rt_never_leaked"])
      assert(!JSON.stringify(json).includes(value), "secret included: " + value.slice(0, 4));
  } finally { await h.close(); }
});

test("GUI requires its page capability and Origin null to reach sensitive endpoints", async () => {
  const h = await harness();
  try {
    assert.equal((await h.api("accounts", undefined, { bearer: "0".repeat(64) })).status, 403);
    assert.equal((await h.api("accounts", undefined, { origin: "https://attacker.test" })).status, 403);
    assert.equal((await h.api("accounts/refresh", { all: true }, { bearer: "0".repeat(64) })).status, 403);
    assert.equal((await h.api("accounts/refresh", { all: true }, { origin: "https://attacker.test" })).status, 403);
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

test("GUI rejects strict validation errors unless skipInvalid is opted in and validates proxy", async () => {
  let seenArgs;
  const h = await harness({
    batch: async (args) => {
      seenArgs = args;
      args.onProgress({ state: "added", line: 2, email: "us***@example.com" });
      return { total: 1, added: 1, reused: 0, failed: [], duplicates: 0, invalid: [{ line: 1, reason: "bad" }] };
    },
  });
  try {
    const txt = `bad-email----pw----${seed}\nuser@example.com----pw----${seed}`;
    const preview = await h.api("preview", { text: txt });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.errors.length, 1);
    assert.equal((await h.api("start", { mode: "pool", consent: true })).status, 422);
    assert.equal((await h.api("start", { mode: "pool", consent: true, skipInvalid: true, proxy: "http://u:p@127.0.0.1:7890" })).status, 400);
    const skipped = await h.api("start", { mode: "pool", consent: true, skipInvalid: true, proxy: "http://127.0.0.1:7890" });
    assert.equal(skipped.status, 202);
    for (let i = 0; i < 20; i++) {
      const st = (await h.api("status")).json;
      if (st.state === "completed") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.equal(seenArgs.skipInvalid, true);
    assert.equal(seenArgs.proxy, "http://127.0.0.1:7890");
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

test("GUI lists, refreshes and removes accounts using opaque ids, not raw emails or tokens", async () => {
  const records = [
    { email: "alice@example.com", accessToken: future(), totp: seed, password: "s" },
    { email: "bob@example.com", accessToken: "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJleHAiOjF9.sig", totp: seed, password: "s2" },
  ];
  let removed;
  let syncCalls = 0;
  const h = await harness({
    poolRead: async () => records,
    poolRemove: async (email) => { removed = email; },
    onPoolChange: async () => { syncCalls++; return { connected: true }; },
    refreshAccount: async (row, opts) => {
      assert.equal(opts.proxy, "http://127.0.0.1:7890");
      if (row.email === "alice@example.com") return { ok: true, status: "valid", renewed: false, tokenState: "unexpired_unverified" };
      return { ok: true, status: "renewed", renewed: true, tokenState: "unexpired_unverified" };
    },
  });
  try {
    const listed = await h.api("accounts");
    assert.equal(listed.status, 200);
    assert.equal(listed.json.total, 2);
    assert.deepEqual(listed.json.summary, { total: 2, valid: 1, needsRenew: 1 });
    assert.equal(listed.json.accounts[0].email, "al***@example.com");
    assert.equal(listed.json.accounts[0].slotLabel, formatAccountSlotLabel("alice@example.com"));
    assert.equal(listed.json.accounts[0].slotTag, accountSlotTag("alice@example.com"));
    assert.equal(listed.json.accounts[0].tokenState, "unexpired_unverified");
    assert.equal(listed.json.accounts[1].tokenState, "expired");
    const opaque = listed.json.accounts[0].id;
    assert.match(opaque, /^[a-f0-9]{32}$/);
    assert(!JSON.stringify(listed.json).includes("alice@example.com"));
    assert(!JSON.stringify(listed.json).includes(records[0].accessToken));

    const refreshed = await h.api("accounts/refresh", { all: true, proxy: "http://127.0.0.1:7890" });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.valid, 1);
    assert.equal(refreshed.json.renewed, 1);
    assert.equal(refreshed.json.failed, 0);
    assert.equal(syncCalls, 1);
    assert(!JSON.stringify(refreshed.json).includes("alice@example.com"));
    assert(!JSON.stringify(refreshed.json).includes("bob@example.com"));

    assert.equal((await h.api("accounts/refresh", { id: opaque, proxy: "socks5://bad" })).status, 400);
    assert.equal((await h.api("remove", { id: opaque })).status, 200);
    assert.equal(removed, "alice@example.com");
    assert.equal((await h.api("remove", { id: opaque })).status, 404);
  } finally { await h.close(); }
});

test("GUI is restricted to loopback, never LAN-exposed", async () => {
  const bad = createGuiService({ port: 0, bind: "0.0.0.0" });
  await assert.rejects(bad.listen(), /127.0.0.1/);
});

test("GUI auto-connects Magpie after successful pool import, no separate login", async () => {
  let linked = 0;
  const h = await harness({
    onPoolChange: async () => { linked++; return { connected: true }; },
    batch: async () => ({ total: 1, added: 1, reused: 0, failed: [] }),
  });
  try {
    await h.api("preview", { text: `owner@example.com----pass----${seed}` });
    assert.equal((await h.api("start", { mode: "pool", consent: true })).status, 202);
    let state;
    for (let i = 0; i < 40; i++) {
      state = (await h.api("status")).json;
      if (state.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(state.result.added, 1);
    assert.equal(state.providerConnected, true);
    assert.equal(linked, 1);
  } finally { await h.close(); }
});

test("only DSH HTTP pool import is exposed by GUI and failed batch cannot connect", async () => {
  const h = await harness({
    onPoolChange: async () => { throw Error("should not connect"); },
    batch: async () => ({ total: 1, added: 0, reused: 0, failed: [{}] }),
  });
  try {
    await h.api("preview", { text: `owner@example.com----pass----${seed}` });
    assert.equal((await h.api("start", { mode: "native", consent: true })).status, 400);
    const started = await h.api("start", { mode: "pool", consent: true });
    assert.equal(started.status, 202);
    let state;
    for (let i = 0; i < 40; i++) {
      state = (await h.api("status")).json;
      if (state.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(state.providerConnected, null);
    assert.equal(state.result.added, 0);
  } finally { await h.close(); }
});

test("GUI GET /api/draft enforces auth/origin, omits secrets from /ui HTML, and consumes one-shot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-gui-draft-"));
  const file = join(dir, "accounts.txt");
  const secretTxt = `bad-line\nowner@example.com----topsecretpass----${seed}`;
  await writeFile(file, secretTxt, { mode: 0o600 });
  const h = await harness();
  try {
    const info = await h.service.stageDraft(file);
    assert.equal(info.filename, "accounts.txt");
    assert.equal(info.count, 1);
    assert.equal(info.errors, 1);

    // /ui HTML must not embed draft text or secrets
    const pageHtml = await (await fetch(h.base + "ui")).text();
    assert(!pageHtml.includes("topsecretpass"));
    assert(!pageHtml.includes("owner@example.com"));
    assert(!pageHtml.includes(seed));

    // Security checks on /api/draft
    assert.equal((await h.api("draft", undefined, { bearer: "0".repeat(64) })).status, 403);
    assert.equal((await h.api("draft", undefined, { origin: "https://attacker.test" })).status, 403);

    // First valid GET consumes draft; second returns hasDraft: false
    const first = await h.api("draft");
    assert.equal(first.status, 200);
    assert.equal(first.json.hasDraft, true);
    assert.equal(first.json.filename, "accounts.txt");
    assert.equal(first.json.text, secretTxt);
    assert.equal(first.json.validCount, 1);
    assert.equal(first.json.errorCount, 1);

    const second = await h.api("draft");
    assert.equal(second.status, 200);
    assert.equal(second.json.hasDraft, false);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUI POST /api/sync and multi-account start progressively synchronize Providers", async () => {
  let syncCalls = 0;
  const h = await harness({
    onPoolChange: async () => {
      syncCalls++;
      return { connected: true, count: 2 };
    },
    batch: async (args) => {
      args.onProgress({ state: "added", line: 1, email: "a1***@example.com" });
      args.onProgress({ state: "added", line: 2, email: "a2***@example.com" });
      return { total: 2, added: 2, reused: 0, failed: [] };
    },
  });
  try {
    assert.equal((await h.api("sync", {}, { origin: "https://attacker.test" })).status, 403);
    const manualSync = await h.api("sync", {});
    assert.equal(manualSync.status, 200);
    assert.deepEqual(manualSync.json, { synced: true, connected: true, count: 2 });
    assert.equal(syncCalls, 1);

    syncCalls = 0;
    const twoAccounts = `a1@example.com----pw1----${seed}\na2@example.com----pw2----${seed}`;
    await h.api("preview", { text: twoAccounts });
    assert.equal((await h.api("start", { mode: "pool", consent: true })).status, 202);
    let state;
    for (let i = 0; i < 40; i++) {
      state = (await h.api("status")).json;
      if (state.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    assert.equal(state.state, "completed");
    assert.equal(state.providerConnected, true);
    assert.equal(state.providerCount, 2);
    assert.equal(syncCalls >= 2, true);
  } finally { await h.close(); }
});

test("GUI exposes 额度统计 tab, per-account image quota pills, GET /api/stats, quotaOnly refresh, and stats cleanup on remove", async () => {
  const alice = "alice@example.com";
  const bob = "bob@example.com";
  const records = [
    { email: alice, accessToken: future(), totp: seed, password: "p1" },
    { email: bob, accessToken: future(), totp: seed, password: "p2" },
  ];
  const store = createInMemoryStatsStore();
  await recordQuotaCheck({ email: alice, quota: 7, hasImageLimit: true, planType: "free" }, { statsStore: store });
  await recordImageCall({ email: alice, success: true, count: 1 }, { statsStore: store });
  await recordQuotaCheck({ email: bob, quota: 0, hasImageLimit: true, planType: "free", restoreAt: new Date(Date.now() + 600_000).toISOString() }, { statsStore: store });
  await recordImageCall({ email: bob, success: false, rateLimited: true, retryAfter: 600 }, { statsStore: store });

  let refreshCount = 0;
  const h = await harness({
    poolRead: async () => records,
    poolRemove: async (email) => {
      const idx = records.findIndex((r) => r.email === email);
      if (idx >= 0) records.splice(idx, 1);
    },
    statsStore: store,
    runWorker: async (payload) => {
      assert.equal(payload.action, "check_image_quota");
      refreshCount++;
      return {
        ok: true,
        quota: refreshCount === 1 ? 12 : 4,
        restore_at: null,
        has_image_limit: true,
        plan_type: refreshCount === 1 ? "plus" : "free",
      };
    },
  });
  try {
    // 1. UI HTML, CSS and JS contain per-account quota + 额度统计 tab and zero forbidden APIs
    for (const label of ['data-tab="stats"', "额度统计", "当前账号", "可用账号", "限流账号", "剩余额度", "成功调用", "失败调用", "refreshStatsQuota", "statsRows"]) {
      assert(h.html.includes(label), "missing HTML element: " + label);
    }
    const styleCss = await (await fetch(h.base + "assets/style.css")).text();
    assert(styleCss.includes(".quota-pill"));
    assert(styleCss.includes(".stats-grid"));
    assert(styleCss.includes(".stat-card-active"));
    const appJs = await (await fetch(h.base + "assets/app.js")).text();
    assert(appJs.includes('api("stats")'));
    assert(appJs.includes("quotaOnly: true"));
    assert(appJs.includes("生图额度："));
    assert(!appJs.includes("innerHTML"));
    assert(!appJs.includes("localStorage"));

    // 2. Auth enforcement on /api/stats
    assert.equal((await h.api("stats", undefined, { bearer: "0".repeat(64) })).status, 403);
    assert.equal((await h.api("stats", undefined, { origin: "https://attacker.test" })).status, 403);

    // 3. Initial /api/stats & /api/accounts payload
    const st1 = await h.api("stats");
    assert.equal(st1.status, 200);
    assert.equal(st1.json.summary.total, 2);
    assert.equal(st1.json.summary.active, 1);
    assert.equal(st1.json.summary.limited, 1);
    assert.equal(st1.json.summary.totalQuota, 6);
    assert.equal(st1.json.summary.totalSuccess, 1);
    assert.equal(st1.json.summary.totalFail, 1);
    assert.equal(st1.json.accounts[0].imageQuota, 6);
    assert.equal(st1.json.accounts[0].quotaStatus, "available");
    assert.equal(st1.json.accounts[1].imageQuota, 0);
    assert.equal(st1.json.accounts[1].quotaStatus, "limited");
    assert(!JSON.stringify(st1.json).includes(alice));
    assert(!JSON.stringify(st1.json).includes(records[0].accessToken));

    // 4. quotaOnly refresh updates both accounts via default refreshPoolAccount + injected runWorker
    const refreshed = await h.api("accounts/refresh", { all: true, quotaOnly: true });
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.quotaChecked, 2);
    assert.equal(refreshed.json.quotaStats.active, 2);
    assert.equal(refreshed.json.quotaStats.limited, 0);
    assert.equal(refreshed.json.quotaStats.totalQuota, 16);
    assert.equal(refreshed.json.accounts[0].planType, "plus");

    // 5. Removing alice cleans up per-account quota while preserving bob & totals
    const aliceId = st1.json.accounts[0].id;
    assert.equal((await h.api("remove", { id: aliceId })).status, 200);
    const st2 = await h.api("stats");
    assert.equal(st2.json.summary.total, 1);
    assert.equal(st2.json.summary.active, 1);
    assert.equal(st2.json.summary.totalQuota, 4);
    assert.equal(st2.json.summary.totalSuccess, 1);
    assert.equal(st2.json.summary.totalFail, 1);
  } finally {
    await h.close();
  }
});
