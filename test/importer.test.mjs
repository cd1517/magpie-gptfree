import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runBatch } from "../lib/importer.mjs";
import { makePKCE, authorizationURL, codexAuthJSON } from "../lib/oauth.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const jwt = (exp) => [
  Buffer.from('{"alg":"RS256","typ":"JWT"}').toString("base64url"),
  Buffer.from(JSON.stringify({ exp })).toString("base64url"), "signature",
].join(".");

test("dry run recognizes all 3 formats, without launching a browser", async () => {
  const content = [
    `a@example.com----p1----${seed}`,
    `b@example.com---p2---${seed}---https://mail.xxx.store/abcd`,
    `c@example.com----p3----${seed}----${jwt(Math.floor(Date.now()/1000)+3600)}`,
  ].join("\n");
  const result = await runBatch({
    file: "virtual.txt", dryRun: true, read: async () => content,
    openBrowser: async () => { throw new Error("should not launch"); },
  });
  assert.equal(result.total, 3);
  assert.deepEqual(result.ready.map((x) => x.kind), ["standard", "mail_link", "access_token"]);
  assert.equal(result.ready[2].tokenState, "unexpired_unverified");
  assert.equal(JSON.stringify(result).includes("p3"), false);
  assert.equal(JSON.stringify(result).includes("mail.xxx.store"), false);
});

test("batch handles links and access tokens without leaking sensitive content or falsely claiming reuse", async () => {
  const future = jwt(Math.floor(Date.now()/1000)+3600);
  const expired = jwt(Math.floor(Date.now()/1000)-3600);
  const secretLink = "https://mail.xxx.store/key---secret";
  const content = [
    `a@example.com----password1----${seed}`,
    `b@example.com----password2----${seed}----${secretLink}`,
    `c@example.com----password3----${seed}----${future}`,
    `d@example.com---password4---${seed}---${expired}`,
  ].join("\n");
  let closed = false, count = 0;
  const calls = [], states = [];
  const result = await runBatch({
    file: "virtual.txt", read: async () => content, consent: true,
    openBrowser: async () => ({ close: async () => { closed = true; } }),
    login: async (account) => {
      calls.push(account.email);
      return { tokens: { access: "a", refresh: "r", id: "i" } };
    },
    importAccount: async () => { count++; },
    onProgress: (event) => states.push(event),
  });
  assert.equal(result.added, 4);
  assert.equal(count, 4);
  assert.equal(result.tokenNeedsOAuth, 2);
  assert.deepEqual(result.formats, { standard: 1, mail_link: 1, access_token: 2 });
  assert.equal(closed, true);
  assert.deepEqual(calls, ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
  assert(states.some((x) => x.state === "mail_link_ignored"));
  assert(states.some((x) => x.state === "token_needs_oauth"));
  assert(states.some((x) => x.state === "token_expired"));
  const printed = JSON.stringify(states);
  for (const x of ["password1", "secretLink", secretLink, future, expired, seed])
    assert.equal(printed.includes(x), false);
});

test("single failure does not discard later records", async () => {
  const txt = [`a@example.com----p----${seed}`, `b@example.com----p----${seed}`].join("\n");
  const r = await runBatch({
    file: "virtual.txt", read: async () => txt, consent: true,
    openBrowser: async () => ({ close() {} }),
    login: async (account) => {
      if (account.email === "a@example.com") throw new Error("token=secret-in-exception");
      return { tokens: { access: "a", refresh: "r", id: "i" } };
    },
    importAccount: async () => true,
  });
  assert.equal(r.added, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(JSON.stringify(r).includes("secret-in-exception"), false);
});

test("PKCE URL targets Codex with state, code challenge, and no password", () => {
  const p = makePKCE();
  assert.notEqual(p.verifier, p.challenge);
  const url = new URL(authorizationURL({ ...p, email: "a@example.com" }));
  assert.equal(url.hostname, "auth.openai.com");
  assert.equal(url.searchParams.get("state"), p.state);
  assert.equal(url.searchParams.get("code_challenge"), p.challenge);
  assert.equal(url.searchParams.get("login_hint"), "a@example.com");
  assert.equal(url.href.includes("password"), false);
});

test("Codex auth.json includes native refresh and id token", () => {
  const obj = codexAuthJSON({ access: "a", refresh: "r", id: "not-a-jwt" });
  assert.equal(obj.auth_mode, "chatgpt");
  assert.equal(obj.tokens.refresh_token, "r");
  assert.equal(obj.tokens.id_token, "not-a-jwt");
});

test("Magpie provider is independent from the GUI file import flow", async () => {
  const plug = await GPTFreePoolPlugin();
  const config = { provider: {} };
  await plug.config(config);
  assert("gptfree-pool" in config.provider);
  assert.equal(plug.auth.methods[0].type, "api");
});
