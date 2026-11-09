import assert from "node:assert/strict";
import { test } from "node:test";
import { createPoolConnector, POOL_PROVIDER, POOL_MARKER } from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const entry = { email: "example@example.com", password: "not-stored-owner-password", totp: "", accessToken: "sample.token" };
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
  assert.deepEqual((await GPTFreePoolPlugin()).auth.methods, []);
});

test("existing pool reconnects to Magpie automatically with a non-secret marker", async () => {
  const h = host();
  const connect = createPoolConnector(h.client, { poolRead: async () => [entry] });
  assert.equal((await connect.sync()).connected, true);
  assert.equal(h.saved.get(POOL_PROVIDER).key, POOL_MARKER);
  assert(!JSON.stringify([...h.saved]).includes(entry.accessToken));
  assert(!JSON.stringify([...h.saved]).includes(entry.password));
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
