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
import { POOL_MARKER } from "../lib/pool-connection.mjs";

const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
async function txtTemp(content = "user@example.com----password----" + seed) {
  const dir = await mkdtemp(join(tmpdir(), "magpie-native-test-"));
  const path = join(dir, "accounts.txt");
  await writeFile(path, content, { mode: 0o600 });
  return { path, close: () => rm(dir, { recursive: true, force: true }) };
}
async function harness({ batch } = {}) {
  const service = createGuiService({ port: 0, batch });
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

test("Providers uses a URL-less OAuth OS file dialog, NOT an importer browser URL", async () => {
  const plugin = await GPTFreePoolPlugin();
  assert.equal(plugin.auth.provider, "gptfree-pool");
  assert.equal(plugin.auth.single, true);
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "oauth");
  assert.equal(plugin.auth.methods[0].keyless, undefined);
  assert.equal(plugin.auth.methods[0].label.includes("GPTFree"), true);
  assert.equal(typeof plugin.auth.methods[0].authorize, "function");
  assert.deepEqual(plugin.auth.methods[0].prompts.map((p) => [p.type, p.key]), [
    ["select", "source"],
    ["select", "ownership"],
  ]);
  assert.equal(plugin.auth.methods[0].prompts[1].when.key, "source");
  assert.equal(plugin.auth.methods[0].prompts[1].when.value, "txt");
  assert.deepEqual(plugin.auth.methods[0].prompts[0].options.map((o) => o.value), ["txt", "existing"]);
});

test("Windows native picker invokes a system OpenFileDialog, never a shell or browser", async () => {
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
  for (const [os, cmd] of Object.entries(NATIVE_PICKER_COMMANDS)) {
    assert(["win32", "darwin", "linux"].includes(os));
    assert(!cmd.args.join(" ").includes("http://"));
  }
});

test("native pick cancel returns failure without storing fake login", async () => {
  const method = nativeImportMethod({
    picker: async () => "",
    server: async () => { throw new Error("server should not start"); },
  });
  assert.deepEqual(method.type, "oauth");
  const result = await method.authorize({ source: "txt", ownership: "yes" });
  assert.equal(result.type, "failed");
  assert.match(result.error, /未选择/);
});

test("native provider chooser starts batch in Magpie host and signs in after first import", async () => {
  const file = await txtTemp();
  const h = await harness({
    batch: async (args) => {
      assert.equal(args.mode, "pool");
      assert.equal(args.consent, true);
      assert.equal(await args.read(), "user@example.com----password----" + seed);
      args.onProgress({ state: "authorizing", email: "us***@example.com", line: 1 });
      args.onProgress({ state: "token_reused", email: "us***@example.com", line: 1 });
      return { total: 1, added: 1, reused: 1, failed: [], duplicates: 0 };
    },
  });
  try {
    const method = nativeImportMethod({
      picker: async () => file.path,
      server: async () => h.service,
    });
    const started = await method.authorize({ source: "txt", ownership: "yes" });
    assert.equal(started.url, "");
    assert.equal(started.opened, true);
    assert.equal(started.method, "auto");
    const result = await started.callback();
    assert.equal(result.type, "success");
    assert.equal(result.key, POOL_MARKER);
    assert(!JSON.stringify(result).includes("password"));
    assert(!JSON.stringify(result).includes(seed));
    let status;
    for (let i = 0; i < 30; i++) {
      status = (await h.api("status")).data;
      if (status.state === "completed") break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(status.state, "completed");
    assert.equal(status.result.added, 1);
    assert.equal(status.result.reused, 1);
    assert.equal(status.events.at(-1).state, "token_reused");
  } finally { await h.close(); await file.close(); }
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
    const started = await method.authorize({ source: "txt", ownership: "yes" });
    assert.equal(started.url, "");
    const result = await started.callback();
    assert.equal(result.type, "failed");
    assert.match(result.error, /没有账号成功入池/);
  } finally { await h.close(); await file.close(); }
});

test("the only import web UI is Magpie's sandboxed page; old browser tickets are rejected", async () => {
  const h = await harness();
  try {
    assert.match(h.page, /data-entry="sidebar"/);
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

test("clicking plugin without submitting the native form must not open any file chooser", async () => {
  let pickCalls = 0, serverCalls = 0;
  const method = nativeImportMethod({
    picker: async () => { pickCalls++; return "/tmp/should-not-open.txt"; },
    server: async () => { serverCalls++; throw Error("not expected"); },
    readPool: async () => [],
  });
  for (const inputs of [undefined, {}, { source: "txt" }, { source: "txt", ownership: "no" }, { source: "unknown" }]) {
    const result = await method.authorize(inputs);
    assert.equal(result.type, "failed");
  }
  assert.equal(pickCalls, 0, "file picker must not appear on provider-name click");
  assert.equal(serverCalls, 0);
});

test("the native form can reconnect an already imported pool without an extra file picker", async () => {
  let pickCalls = 0, readCalls = 0;
  const method = nativeImportMethod({
    picker: async () => { pickCalls++; throw Error("no file picker"); },
    server: async () => { throw Error("no GUI service needed"); },
    readPool: async () => {
      readCalls++;
      return [{ email: "saved@example.com", password: "redacted",
        totp: "", accessToken: "opaque.token.value" }];
    },
  });
  const started = await method.authorize({ source: "existing" });
  assert.equal(started.url, "");
  const result = await started.callback();
  assert.equal(result.type, "success");
  assert.equal(result.key, POOL_MARKER);
  assert.equal(readCalls, 1);
  assert.equal(pickCalls, 0);
  assert(!JSON.stringify(result).includes("opaque.token.value"));
});

test("empty existing pool is rejected without creating a fake Magpie login", async () => {
  const method = nativeImportMethod({
    readPool: async () => [],
    picker: async () => { throw Error("do not open"); },
  });
  const result = await method.authorize({ source: "existing" });
  assert.equal(result.type, "failed");
  assert.match(result.error, /号池为空/);
});
