import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertPool, listPool, removePool } from "../lib/pool-vault.mjs";
import {
  verifyAccessToken, poolFetch, prepareCodexBody, CODEX_BASE,
  renewAccount, discoverPoolModels, refreshPoolAccount,
} from "../lib/codex-pool.mjs";
import { accountSlotTag, buildSlotAuthBody } from "../lib/pool-connection.mjs";
import { runBatch } from "../lib/importer.mjs";
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

function okModels() {
  return new Response(JSON.stringify({
    models: [
      { slug: "gpt-6", display_name: "GPT 6", visibility: "list", context_window: 123456 },
      { slug: "not-listed", visibility: "hide" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("vault keeps sensitive fields encrypted, updates and removes records", async () => {
  const root = await mkdtemp(join(tmpdir(), "gptfree-test-"));
  try {
    const record = { email: "a@example.com", password: "super-secret-password",
      totp: seed, accessToken: jwt(3600) };
    await upsertPool(record, { root });
    const rows = await listPool({ root });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].password, "super-secret-password");
    assert.equal(rows[0].totp, seed);
    const encrypted = await readFile(join(root, "pool.enc.json"), "utf8");
    assert.equal(encrypted.includes("super-secret-password"), false);
    assert.equal(encrypted.includes(seed), false);
    assert.equal(encrypted.includes(rows[0].accessToken), false);
    await upsertPool({ ...record, password: "second-secret" }, { root });
    assert.equal((await listPool({ root })).length, 1);
    assert.equal((await listPool({ root }))[0].password, "second-secret");
    assert.equal((await removePool("a@example.com", { root })).removed, 1);
    assert.equal((await listPool({ root })).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("unexpired JWT is only admitted after real Codex model probe", async () => {
  let requested = "";
  const token = jwt(3600);
  const success = await verifyAccessToken(token, {
    expectedEmail: "a@example.com",
    fetcher: async (url, opts) => {
      requested = url;
      assert.equal(opts.headers.get("authorization"), "Bearer " + token);
      assert.equal(opts.headers.get("chatgpt-account-id"), "acct123");
      assert.equal(opts.redirect, "error");
      return okModels();
    },
  });
  assert(success.accepted);
  assert(requested.endsWith("/models?client_version=0.164.0"));
  assert.deepEqual(Object.keys(success.models), ["gpt-6"]);
  assert.equal(success.models["gpt-6"].limit.context, 123456);
  assert.equal((await verifyAccessToken(jwt(-100), { fetcher: () => {
    throw new Error("Should not contact server for expired token");
  } })).accepted, false);
  assert.equal((await verifyAccessToken(token, { expectedEmail: "someone-else@example.com",
    fetcher: () => { throw new Error("should not contact server"); } })).reason, "identity_mismatch");
  assert.equal((await verifyAccessToken(token, { fetcher: async () =>
    new Response("{}", { status: 401 }) })).accepted, false);
});

test("pool mode reuses live token without browser, falls back on rejected/expired", async () => {
  const reusable = jwt(3600, "a@example.com");
  const expired = jwt(-3600, "b@example.com");
  const content = [
    `a@example.com----p1----${seed}----${reusable}`,
    `b@example.com----p2----${seed}----${expired}`,
  ].join("\n");
  const saved = [], states = [];
  let logins = 0;
  const r = await runBatch({
    file: "virtual.txt", consent: true, mode: "pool",
    read: async () => content,
    verifyToken: async (token) => ({ accepted: token === reusable || token === "fresh-after-login" }),
    login: async () => { logins++; return { tokens: { access: "fresh-after-login", id: "id", refresh: "refresh" } }; },
    savePool: async (item) => { saved.push(item); },
    onProgress: (event) => { states.push(event); },
  });
  assert.equal(r.mode, "pool");
  assert.equal(r.reused, 1);
  assert.equal(r.added, 2);
  assert.equal(r.tokenNeedsOAuth, 1);
  assert.equal(logins, 1);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].accessToken, reusable);
  assert.equal(saved[1].accessToken, "fresh-after-login");
  assert(states.some((event) => event.state === "token_reused"));
  const log = JSON.stringify(states);
  assert(!log.includes(reusable) && !log.includes(expired) && !log.includes(seed) && !log.includes("p1"));
});

test("removed native Codex CLI import mode is rejected", async () => {
  await assert.rejects(runBatch({
    file: "virtual.txt", consent: true, mode: "native",
    read: async () => `a@example.com----pw----${seed}`,
  }), /Codex CLI/);
});

test("Responses payload is adapted for Codex backend and preserves tool input", () => {
  const raw = { model: "gpt-6", input: [{ type: "message", role: "system", id: "some-id",
    content: [{ type: "input_text", text: "hello" }] }],
    stream: false, store: true, temperature: 0.8, max_output_tokens: 4000 };
  const b = JSON.parse(prepareCodexBody(raw));
  assert.equal(b.store, false);
  assert.equal(b.stream, true);
  assert.equal(b.temperature, undefined);
  assert.equal(b.max_output_tokens, undefined);
  assert.equal(b.input[0].role, "developer");
  assert.equal(b.input[0].id, undefined);
  assert(b.include.includes("reasoning.encrypted_content"));
});

test("pool request uses local vault token and fails over when one account rate limits", async () => {
  const account1 = { email: "a@example.com", password: "p", totp: seed, accessToken: jwt(3600) };
  const account2 = { email: "b@example.com", password: "p", totp: seed, accessToken: jwt(3600, "b@example.com") };
  const used = [];
  const f = async (url, init) => {
    assert.equal(url, CODEX_BASE + "/responses");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.get("OpenAI-Beta"), "responses=experimental");
    const auth = init.headers.get("authorization");
    used.push(auth);
    return used.length === 1 ? new Response("limited", { status: 429 }) :
      new Response("data: done\n\n", { status: 200 });
  };
  const response = await poolFetch(CODEX_BASE + "/responses",
    { body: '{"model":"gpt-6","input":"hi"}', method: "POST" },
    { read: async () => [account1, account2], fetcher: f });
  assert.equal(response.status, 200);
  assert.equal(used.length, 2);
  assert.notEqual(used[0], used[1]);
  assert.equal(await response.text(), "data: done\n\n");
});

test("multi-account pool rotates across accounts on successive requests", async () => {
  const accounts = [
    { email: "r1@example.com", password: "p", totp: seed, accessToken: jwt(3600, "r1@example.com") },
    { email: "r2@example.com", password: "p", totp: seed, accessToken: jwt(3600, "r2@example.com") },
    { email: "r3@example.com", password: "p", totp: seed, accessToken: jwt(3600, "r3@example.com") },
  ];
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const res = await poolFetch(CODEX_BASE + "/responses",
      { body: '{"model":"gpt-6","input":"hi"}', method: "POST" },
      {
        read: async () => accounts,
        fetcher: async (_url, init) => {
          seen.push(init.headers.get("authorization"));
          return new Response("data: ok\n\n", { status: 200 });
        },
      });
    assert.equal(res.status, 200);
  }
  assert.equal(new Set(seen).size, 3);
});

test("discoverPoolModels renews expired multi-account pool and skips failed accounts", async () => {
  const dead = { email: "dead@example.com", password: "p", totp: seed, accessToken: jwt(-3600, "dead@example.com") };
  const recoverable = { email: "ok@example.com", password: "p", totp: seed, accessToken: jwt(-3600, "ok@example.com") };
  const renewedToken = jwt(3600, "ok@example.com");
  const models = await discoverPoolModels({
    read: async () => [dead, recoverable],
    reauthenticate: async (account) => {
      if (account.email === "dead@example.com") throw new Error("locked");
      return { ...account, accessToken: renewedToken };
    },
    fetcher: async (_url, opts) => {
      if (opts.headers.get("authorization") === "Bearer " + renewedToken) return okModels();
      return new Response("{}", { status: 401 });
    },
  });
  assert.deepEqual(Object.keys(models), ["gpt-6", "gpt-image-2"]);
  assert.equal(models["gpt-6"].api.npm, "@ai-sdk/openai");
  assert.equal(models["gpt-image-2"].api.npm, "@ai-sdk/openai-compatible");
  assert.equal(models["gpt-image-2"].capabilities.output.image, true);
});

test("preferredSlot tries the selected Magpie account first in poolFetch and discoverPoolModels, then fails over", async () => {
  const accountA = { email: "alpha@example.com", password: "p", totp: seed, accessToken: jwt(3600, "alpha@example.com") };
  const accountB = { email: "beta@example.com", password: "p", totp: seed, accessToken: jwt(3600, "beta@example.com") };
  const slotB = accountSlotTag(accountB.email);

  // 1. poolFetch hits preferred accountB first
  const directAuths = [];
  const okRes = await poolFetch(CODEX_BASE + "/responses",
    { body: '{"model":"gpt-6","input":"hi"}', method: "POST" },
    {
      read: async () => [accountA, accountB],
      preferredSlot: slotB,
      fetcher: async (_url, init) => {
        directAuths.push(init.headers.get("authorization"));
        return new Response("data: ok\n\n", { status: 200 });
      },
    });
  assert.equal(okRes.status, 200);
  assert.deepEqual(directAuths, ["Bearer " + accountB.accessToken]);

  // 2. When preferred accountB returns 429, poolFetch fails over to accountA
  const failoverAuths = [];
  const failoverRes = await poolFetch(CODEX_BASE + "/responses",
    { body: '{"model":"gpt-6","input":"hi"}', method: "POST" },
    {
      read: async () => [accountA, accountB],
      preferredSlot: slotB,
      fetcher: async (_url, init) => {
        const auth = init.headers.get("authorization");
        failoverAuths.push(auth);
        return auth === "Bearer " + accountB.accessToken
          ? new Response("rate limited", { status: 429 })
          : new Response("data: failover\n\n", { status: 200 });
      },
    });
  assert.equal(failoverRes.status, 200);
  assert.deepEqual(failoverAuths, [
    "Bearer " + accountB.accessToken,
    "Bearer " + accountA.accessToken,
  ]);

  // 3. discoverPoolModels probes preferred slot first
  const probeOrder = [];
  const catalog = await discoverPoolModels({
    read: async () => [accountA, accountB],
    preferredSlot: slotB,
    fetcher: async (_url, opts) => {
      probeOrder.push(opts.headers.get("authorization"));
      return okModels();
    },
  });
  assert.deepEqual(Object.keys(catalog), ["gpt-6", "gpt-image-2"]);
  assert.deepEqual(probeOrder, ["Bearer " + accountB.accessToken]);

  // 4. GPTFreePoolPlugin wires auth.metadata.poolSlot cleanly into loader & models without throwing
  const plug = await GPTFreePoolPlugin();
  const authBodyB = buildSlotAuthBody(accountB.email);
  const loaderOpts = await plug.auth.loader(async () => authBodyB);
  assert.equal(typeof loaderOpts.fetch, "function");
  assert.deepEqual(await plug.provider.models({}, {}), {});
});

test("refreshPoolAccount checks valid tokens and renews expired ones without leaking secrets", async () => {
  const validAcc = { email: "live@example.com", password: "secret", totp: seed, accessToken: jwt(3600, "live@example.com") };
  const liveRes = await refreshPoolAccount(validAcc, {
    verify: async () => ({ accepted: true, models: { "gpt-6": {} } }),
    reauthenticate: async () => { throw Error("should not reauthenticate valid account"); },
  });
  assert.deepEqual(liveRes, {
    ok: true, status: "valid", renewed: false, tokenState: "unexpired_unverified", modelCount: 1,
  });

  const expiredAcc = { email: "old@example.com", password: "secret", totp: seed, accessToken: jwt(-300, "old@example.com") };
  let passedProxy = "";
  const renewRes = await refreshPoolAccount(expiredAcc, {
    proxy: "http://127.0.0.1:7890",
    reauthenticate: async (acc, opts) => {
      passedProxy = opts.proxy;
      return { ...acc, accessToken: jwt(3600, acc.email) };
    },
  });
  assert.equal(passedProxy, "http://127.0.0.1:7890");
  assert.equal(renewRes.ok, true);
  assert.equal(renewRes.status, "renewed");
  assert.equal(renewRes.renewed, true);

  const failRes = await refreshPoolAccount(expiredAcc, {
    reauthenticate: async () => { throw new Error("raw-secret-token=abc"); },
  });
  assert.equal(failRes.ok, false);
  assert.equal(failRes.status, "failed");
  assert(!failRes.reason.includes("raw-secret-token"));
});

test("pool rejects exfiltration URLs before sending credentials", async () => {
  await assert.rejects(poolFetch("https://attacker.invalid/v1/responses",
    { body: '{}' }, { read: async () => [] }), /only forwards/);
});

test("pool plugin exposes provider and keyless sign-in", async () => {
  const hooks = await GPTFreePoolPlugin();
  const config = { provider: {} };
  await hooks.config(config);
  assert.equal(config.provider["gptfree-pool"].api, CODEX_BASE);
  assert.equal(config.provider["gptfree-pool"].npm, "@ai-sdk/openai");
  assert.equal(hooks.auth.methods.length, 1); assert.equal(hooks.auth.methods[0].type, "oauth"); // OAuth URL-less native OS file import
});

test("expired-token reauthentication uses the same DSH HTTP path, with no browser", async () => {
  const old = { email: "renewed@example.com", password: "p", totp: seed, accessToken: jwt(-100) };
  const saved = [];
  let logins = 0;
  const renewed = await renewAccount(old, {
    authenticate: async (account) => {
      logins++;
      assert.equal(account.email, "renewed@example.com");
      return { tokens: { access: "new-platform-token" } };
    },
    verify: async (token, opts) => {
      assert.equal(token, "new-platform-token");
      assert.equal(opts.expectedEmail, "renewed@example.com");
      return { accepted: true };
    },
    save: async (record) => saved.push(record),
  });
  assert.equal(logins, 1);
  assert.equal(saved.length, 1);
  assert.equal(renewed.accessToken, "new-platform-token");
});

test("expired-token reauthentication refuses unverified Platform OAuth tokens", async () => {
  const account = { email: "reject@example.com", password: "p", totp: seed, accessToken: jwt(-100) };
  await assert.rejects(renewAccount(account, {
    authenticate: async () => ({ tokens: { access: "platform-only" } }),
    verify: async () => ({ accepted: false }),
    save: async () => { throw Error("must not save rejected token"); },
  }), /不能用于当前 Magpie 模型接口/);
});
