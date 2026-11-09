import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPoolConnector, formatPoolAccountLabel, POOL_PROVIDER, POOL_MARKER,
} from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const entry = { email: "example@example.com", password: "not-stored-owner-password", totp: "", accessToken: "sample.token" };
const entry2 = { email: "second@example.com", password: "not-stored-owner-password-2", totp: "", accessToken: "sample.token.2" };
function host() {
  const saved = new Map();
  const client = { auth: {
    async set({ path, body }) { saved.set(path.id, body); return { data: true }; },
    async remove({ path }) { saved.delete(path.id); return { data: true }; },
  }};
  return { client, saved };
}

test("empty local pool has no provider sign-in and no separate login method", async () => {
  const h = host();
  const connect = createPoolConnector(h.client, { poolRead: async () => [] });
  assert.deepEqual(await connect.sync(), { connected: false, count: 0 });
  assert.equal(h.saved.size, 0);
  assert.equal((await GPTFreePoolPlugin()).auth.methods[0].type, "oauth");
});

test("existing pool reconnects to Magpie automatically with a non-secret marker and reflects pool count", async () => {
  const h = host();
  let rows = [entry];
  const connect = createPoolConnector(h.client, { poolRead: async () => rows });
  assert.equal((await connect.sync()).connected, true);
  assert.equal(h.saved.get(POOL_PROVIDER).key, POOL_MARKER);
  assert.equal(h.saved.get(POOL_PROVIDER).accountId, formatPoolAccountLabel(1));
  rows = [entry, entry2];
  assert.deepEqual(await connect.sync(), { connected: true, count: 2 });
  assert.equal(h.saved.get(POOL_PROVIDER).accountId, "GPTFree 号池 (2 个账号)");
  assert(!JSON.stringify([...h.saved]).includes(entry.accessToken));
  assert(!JSON.stringify([...h.saved]).includes(entry.password));
  assert(!JSON.stringify([...h.saved]).includes(entry2.email));
  const opts = await (await GPTFreePoolPlugin()).auth.loader(async () => h.saved.get(POOL_PROVIDER));
  assert.equal(opts.apiKey, POOL_MARKER);
});

test("after the last account is removed, Magpie's connection is removed too", async () => {
  const h = host();
  let rows = [entry];
  const connect = createPoolConnector(h.client, { poolRead: async () => rows });
  await connect.sync();
  assert.equal(h.saved.has(POOL_PROVIDER), true);
  rows = [];
  assert.equal((await connect.sync()).connected, false);
  assert.equal(h.saved.has(POOL_PROVIDER), false);
});
