import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createGuiService } from "../lib/gui-service.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";
import { nativeImportMethod } from "../lib/provider-native-signin.mjs";
import { pickAccountTxt, NATIVE_PICKER_COMMANDS } from "../lib/native-file-dialog.mjs";
import {
  POOL_MARKER, POOL_PROVIDER, accountSlotTag, createPoolConnector, formatAccountSlotLabel,
} from "../lib/pool-connection.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
async function txtTemp(content = "user@example.com----password----" + seed) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-native-test-"));
  const path = join(dir, "accounts.txt");
  await writeFile(path, content, { mode: 0o600 });
  return { path, close: () => rm(dir, { recursive: true, force: true }) };
}
async function harness(options = {}) {
  const service = createGuiService({ port: 0, ...options });
  const address = await service.listen();
  const base = "http://127.0.0.1:" + address.port;
  const page = await (await fetch(base + "/ui")).text();
  const session = page.match(/meta name="gptfree-session" content="([a-f0-9]{64})"/)?.[1];
  assert(session);
  const api = async (route, body, origin = "null") => {
    const response = await fetch(base + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Origin: origin, "X-GPTFree-Session": session,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { service, base, page, api, close: () => service.close() };
}

test("Providers uses GPT号池 display name and URL-less direct file dialog with zero select prompt buttons", async () => {
  const plugin = await GPTFreePoolPlugin();
  const cfg = { provider: {} };
  await plugin.config(cfg);
  assert.equal(cfg.provider[POOL_PROVIDER].name, "GPT号池");
  assert.equal(plugin.auth.provider, "gptfree-pool");
  assert.equal(plugin.auth.single, undefined);
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "oauth");
  assert.equal(plugin.auth.methods[0].keyless, undefined);
  assert.equal(plugin.auth.methods[0].prompts, undefined);
  assert.equal(plugin.auth.methods[0].label.includes("GPT号池"), true);
  assert.equal(typeof plugin.auth.methods[0].authorize, "function");
});

test("Windows native picker invokes a system OpenFileDialog titled GPT号池, never a shell or browser", async () => {
  let used;
  const value = await pickAccountTxt({
    platform: "win32",
    runner: async (bin, args, opts) => {
      used = { bin, args, opts };
      return { stdout: "C:\\my accounts\\list.txt\r\n" };
    },
  });
  assert.equal(value, "C:\\my accounts\\list.txt");
  assert.equal(used.bin, "powershell.exe");
  assert.equal(used.opts.shell, false);
  assert.equal(used.opts.windowsHide, true);
  assert.equal(used.args.includes("-STA"), true);
  assert.equal(used.args.join(" ").includes("OpenFileDialog"), true);
  assert.equal(used.args.join(" ").includes("GPT号池"), true);
  for (const [os, cmd] of Object.entries(NATIVE_PICKER_COMMANDS)) {
    assert(["win32", "darwin", "linux"].includes(os));
    assert(!cmd.args.join(" ").includes("http://"));
  }
});

test("clicking plugin immediately opens native picker dialog without prompt buttons and cancel returns failure", async () => {
  let pickCalls = 0, serverCalls = 0;
  const method = nativeImportMethod({
    picker: async () => { pickCalls++; return ""; },
    server: async () => { serverCalls++; throw new Error("server should not start"); },
  });
  assert.equal(method.type, "oauth");
  assert.equal(method.prompts, undefined);
  const r1 = await method.authorize(undefined);
  const r2 = await method.authorize();
  assert.equal(pickCalls, 2);
  assert.equal(serverCalls, 0);
  assert.equal(r1.type, "failed");
  assert.equal(r2.type, "failed");
  assert.match(r1.error, /未选择/);
  assert.match(r1.error, /GPT号池/);

  const ac = new AbortController();
  ac.abort();
  const aborted = await method.authorize(undefined, { signal: ac.signal });
  assert.equal(aborted.type, "failed");
  assert.equal(pickCalls, 2);
});

test("native provider chooser starts batch in Magpie host and signs in with non-collapsing metadata", async () => {
  const file = await txtTemp();
  const slotTag = accountSlotTag("user@example.com");
  const accountLabel = formatAccountSlotLabel("user@example.com");
  const claimed = [];
  const h = await harness({
    batch: async (args) => {
      assert.equal(args.mode, "pool");
      assert.equal(args.consent, true);
      assert.equal(await args.read(), "user@example.com----password----" + seed);
      args.onProgress({ state: "authorizing", email: "us***@example.com", line: 1 });
      args.onProgress({ state: "token_reused", email: "us***@example.com", line: 1, slotTag, accountLabel });
      return { total: 1, added: 1, reused: 1, failed: [], duplicates: 0 };
    },
  });
  try {
    const method = nativeImportMethod({
      picker: async () => file.path,
      server: async () => h.service,
      activeKey: () => `${POOL_PROVIDER}#entry0`,
      claimSlotKey: (slot, key) => claimed.push({ slot, key }),
    });
    const started = await method.authorize();
    assert.equal(started.url, "");
    assert.equal(started.opened, true);
    assert.equal(started.method, "auto");
    const result = await started.callback();
    assert.equal(result.type, "success");
    assert.equal(result.key, POOL_MARKER);
    assert.equal(result.metadata.email, accountLabel);
    assert.equal(result.metadata.poolSlot, slotTag);
    assert.deepEqual(claimed, [{ slot: slotTag, key: `${POOL_PROVIDER}#entry0` }]);
    assert(!JSON.stringify(result).includes("password"));
    assert(!JSON.stringify(result).includes("user@example.com"));
    assert(!JSON.stringify(result).includes(seed));
    let status;
    for (let i = 0; i < 30; i++) {
      status = (await h.api("status")).data;
      if (status.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.state, "completed");
    assert.equal(status.result.added, 1);
    assert.equal(status.result.reused, 1);
    assert.equal(status.events.at(-1).state, "token_reused");
  } finally { await h.close(); await file.close(); }
});

test("native provider multi-account TXT registers every imported account individually in Magpie", async () => {
  const a1 = "alpha1@example.com";
  const a2 = "alpha2@example.com";
  const content = `${a1}----pw1----${seed}\n${a2}----pw2----${seed}`;
  const file = await txtTemp(content);
  const vault = [];
  const saved = new Map();
  const connector = createPoolConnector({
    auth: {
      async set({ path, body }) { saved.set(path.id, body); return { data: true }; },
      async remove({ path }) { saved.delete(path.id); return { data: true }; },
    },
  }, { poolRead: async () => vault });

  const h = await harness({
    onPoolChange: () => connector.sync(),
    batch: async (args) => {
      vault.push({ email: a1, password: "pw1", totp: seed, accessToken: "tok-1" });
      args.onProgress({
        state: "added",
        line: 1,
        email: "al***@example.com",
        slotTag: accountSlotTag(a1),
        accountLabel: formatAccountSlotLabel(a1),
      });
      vault.push({ email: a2, password: "pw2", totp: seed, accessToken: "tok-2" });
      args.onProgress({
        state: "added",
        line: 2,
        email: "al***@example.com",
        slotTag: accountSlotTag(a2),
        accountLabel: formatAccountSlotLabel(a2),
      });
      return { total: 2, added: 2, reused: 0, failed: [], duplicates: 0 };
    },
  });
  try {
    const method = nativeImportMethod({
      picker: async () => file.path,
      server: async () => h.service,
      activeKey: () => POOL_PROVIDER,
      claimSlotKey: (slot, key) => connector.claimKey(slot, key),
    });
    const started = await method.authorize();
    const result = await started.callback();
    assert.equal(result.type, "success");
    assert.equal(result.metadata.email, formatAccountSlotLabel(a1));
    assert.equal(result.metadata.poolSlot, accountSlotTag(a1));

    let status;
    for (let i = 0; i < 40; i++) {
      status = (await h.api("status")).data;
      if (status.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.state, "completed");
    assert.equal(status.providerConnected, true);
    assert.equal(status.providerCount, 2);
    assert.equal(saved.size, 2);
    assert.equal(saved.get(POOL_PROVIDER).metadata.poolSlot, accountSlotTag(a1));
    assert.equal(saved.get(`${POOL_PROVIDER}#${accountSlotTag(a2)}`).metadata.poolSlot, accountSlotTag(a2));
    assert.notEqual(
      saved.get(POOL_PROVIDER).metadata.email,
      saved.get(`${POOL_PROVIDER}#${accountSlotTag(a2)}`).metadata.email,
    );
  } finally { await h.close(); await file.close(); }
});

test("malformed TXT picked from dialog auto-stages into sidebar GPT号池 draft without secrets in /ui HTML", async () => {
  const mixed = `bad-email----wrong\nvalid@example.com----super-pw----${seed}`;
  const file = await txtTemp(mixed);
  const h = await harness();
  try {
    const method = nativeImportMethod({
      picker: async () => file.path,
      server: async () => h.service,
    });
    const strictFail = await method.authorize(undefined);
    assert.equal(strictFail.type, "failed");
    assert.match(strictFail.error, /第 1 行/);
    assert.match(strictFail.error, /左侧菜单「GPT号池」/);
    assert(!strictFail.error.includes("super-pw"));
    assert(!strictFail.error.includes(seed));

    const uiAfter = await (await fetch(h.base + "/ui")).text();
    assert(!uiAfter.includes("super-pw"));

    const staged = await h.api("draft");
    assert.equal(staged.status, 200);
    assert.equal(staged.data.hasDraft, true);
    assert.equal(staged.data.text, mixed);
    assert.equal(staged.data.validCount, 1);
    assert.equal(staged.data.errorCount, 1);
  } finally { await h.close(); await file.close(); }
});

test("native picker unavailability failure falls back to clear sidebar GPT号池 hint", async () => {
  const method = nativeImportMethod({
    picker: async () => { throw new Error("unexpected dialog crash"); },
    server: async () => { throw new Error("server should not start"); },
  });
  const res = await method.authorize();
  assert.equal(res.type, "failed");
  assert.match(res.error, /左侧菜单「GPT号池」/);
});

test("native provider all-failed import never marks Magpie as signed in", async () => {
  const file = await txtTemp();
  const h = await harness({
    batch: async (args) => {
      args.onProgress({ state: "failed", email: "us***@example.com", line: 1, reason: "授权失败" });
      return { total: 1, added: 0, reused: 0, failed: [{ line: 1 }], duplicates: 0 };
    },
  });
  try {
    const method = nativeImportMethod({
      picker: async () => file.path, server: async () => h.service,
    });
    const started = await method.authorize();
    assert.equal(started.url, "");
    const result = await started.callback();
    assert.equal(result.type, "failed");
    assert.match(result.error, /没有账号成功入池/);
    assert.match(result.error, /GPT号池/);
  } finally { await h.close(); await file.close(); }
});

test("the only import web UI is Magpie's sandboxed page; old browser tickets are rejected", async () => {
  const h = await harness();
  try {
    assert.match(h.page, /data-entry="sidebar"/);
    assert.match(h.page, /GPT号池/);
    assert.match(h.page, /批量导入账号/);
    const wrong = await fetch(h.base + "/ui?ticket=" + "f".repeat(48));
    assert.equal(wrong.status, 410);
    assert.equal((await h.api("preview", { text: "user@example.com----pw" }, "https://outside.example")).status, 403);
    assert.equal((await h.api("preview", { text: "user@example.com----pw" }, h.base)).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = httpRequest(h.base + "/api/status", {
        method: "GET",
        headers: { Host: "outside.invalid", Origin: "null", "X-GPTFree-Session": "1".repeat(64) },
      }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(hostStatus, 403);
  } finally { await h.close(); }
});
