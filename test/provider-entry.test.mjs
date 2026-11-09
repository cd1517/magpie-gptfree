import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { createGuiService } from "../lib/gui-service.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
async function serviceHarness({ batch } = {}) {
  const service = createGuiService({ port: 0, batch });
  const addr = await service.listen();
  const base = "http://127.0.0.1:" + addr.port;
  const open = async () => {
    const ticket = service.issueProviderEntry({ ttlMs: 30000 });
    const htmlResp = await fetch(ticket.url);
    const html = await htmlResp.text();
    const session = html.match(/meta name="gptfree-session" content="([a-f0-9]{64})"/)?.[1];
    assert.equal(htmlResp.status, 200);
    assert(session);
    assert.match(html, /data-entry="provider"/);
    return { ticket, session };
  };
  const api = async (session, route, body, origin = base) => {
    const response = await fetch(base + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "X-GPTFree-Session": session,
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { service, base, open, api, close: () => service.close() };
}

test("Providers card advertises a single GUI-entry OAuth method, not an empty list", async () => {
  const plugin = await GPTFreePoolPlugin();
  assert.equal(plugin.auth.provider, "gptfree-pool");
  assert.equal(plugin.auth.single, true);
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "oauth");
  assert.match(plugin.auth.methods[0].label, /图形界面导入账号/);
});

test("Providers URL serves the import GUI and completes on first successful pool account", async () => {
  let started = 0;
  const h = await serviceHarness({
    batch: async (opts) => {
      started++;
      assert.equal(opts.mode, "pool");
      opts.onProgress({ state: "token_reused", line: 1, email: "us***@example.com" });
      return { total: 1, added: 1, reused: 1, failed: [] };
    },
  });
  try {
    const { ticket, session } = await h.open();
    const text = "user@example.com----pw----" + seed;
    assert.equal((await h.api(session, "preview", { text })).status, 200);
    assert.equal((await h.api(session, "start", { mode: "pool", consent: true })).status, 202);
    const outcome = await ticket.wait();
    assert.deepEqual(outcome, { ok: true, error: "" });
    assert.equal(started, 1);
  } finally { await h.close(); }
});

test("Provider GUI import rejects native Codex mode; the sidebar keeps that option", async () => {
  const h = await serviceHarness({
    batch: async () => { throw Error("should not start"); },
  });
  try {
    const { ticket, session } = await h.open();
    await h.api(session, "preview", { text: "user@example.com----pw----" + seed });
    const response = await h.api(session, "start", { mode: "native", consent: true });
    assert.equal(response.status, 422);
    assert.match(response.data.error, /Token 号池/);
    const direct = await fetch(h.base + "/ui");
    assert.equal(direct.status, 200);
    assert.match(await direct.text(), /data-entry="sidebar"/);
  } finally { await h.close(); }
});

test("failed pool import never pretends Magpie signed in", async () => {
  const h = await serviceHarness({
    batch: async () => ({ total: 1, added: 0, reused: 0, failed: [{ line: 1, reason: "failed" }] }),
  });
  try {
    const { ticket, session } = await h.open();
    await h.api(session, "preview", { text: "user@example.com----pw----" + seed });
    assert.equal((await h.api(session, "start", { mode: "pool", consent: true })).status, 202);
    const result = await ticket.wait();
    assert.equal(result.ok, false);
    assert.match(result.error, /没有账号成功/);
  } finally { await h.close(); }
});

test("invalid ticket is rejected; different browser origins and rebinding hosts cannot import", async () => {
  const h = await serviceHarness();
  try {
    const wrong = await fetch(h.base + "/ui?ticket=" + "f".repeat(48));
    assert.equal(wrong.status, 410);
    const { session } = await h.open();
    assert.equal((await h.api(session, "preview", { text: "user@example.com----pw" }, "https://other.example")).status, 403);
    // fetch() normalizes the Host header; raw HTTP is needed to test
    // DNS-rebinding defense against a forged Host.
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest(h.base + "/api/status", {
        method: "GET",
        headers: { Host: "outside.invalid", Origin: "null", "X-GPTFree-Session": session },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally { await h.close(); }
});
