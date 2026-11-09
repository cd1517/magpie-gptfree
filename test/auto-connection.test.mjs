import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountSlotTag, createPoolConnector, formatAccountSlotLabel,
  POOL_PROVIDER, POOL_MARKER,
} from "../lib/pool-connection.mjs";
import { GPTFreePoolPlugin } from "../index.mjs";

const entry = { email: "example1@example.com", password: "not-stored-owner-password-1", totp: "", accessToken: "sample.token.1" };
const entry2 = { email: "example2@example.com", password: "not-stored-owner-password-2", totp: "", accessToken: "sample.token.2" };
const entry3 = { email: "third@example.com", password: "not-stored-owner-password-3", totp: "", accessToken: "sample.token.3" };

function host() {
  const saved = new Map();
  const scope = new AsyncLocalStorage();
  const resolveKey = (id) => {
    const active = scope.getStore();
    return active && id === active.provider ? active.key : id;
  };
  const client = {
    auth: {
      async set({ path, body }) { saved.set(resolveKey(path.id), body); return { data: true }; },
      async remove({ path }) { saved.delete(resolveKey(path.id)); return { data: true }; },
    },
  };
  const magpie = {
    account(provider) {
      const active = scope.getStore();
      return active && active.provider === provider ? active.key : undefined;
    },
  };
  return { client, magpie, saved, scope };
}

test("empty local pool has no provider sign-in and multi-account oauth is enabled", async () => {
  const h = host();
  h.saved.set(POOL_PROVIDER, { type: "api", key: POOL_MARKER });
  const connect = createPoolConnector(h.client, { poolRead: async () => [] });
  assert.deepEqual(await connect.sync(), { connected: false, count: 0, accounts: [] });
  assert.equal(h.saved.size, 0);
  const plugin = await GPTFreePoolPlugin();
  assert.equal(plugin.auth.single, undefined);
  assert.equal(plugin.auth.methods[0].type, "oauth");
});

test("multi-account pool registers every account individually with unique masked labels and zero secrets", async () => {
  const h = host();
  let rows = [entry];
  const connect = createPoolConnector(h.client, { poolRead: async () => rows });
  const first = await connect.sync();
  assert.equal(first.connected, true);
  assert.equal(first.count, 1);
  assert.equal(h.saved.size, 1);
  assert.equal(h.saved.get(POOL_PROVIDER).key, POOL_MARKER);
  assert.equal(h.saved.get(POOL_PROVIDER).accountId, formatAccountSlotLabel(entry.email));
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.email, formatAccountSlotLabel(entry.email));
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolSlot, accountSlotTag(entry.email));

  // Notice entry and entry2 share the same masked prefix ("ex***@example.com")
  // yet still produce distinct labels & poolSlot tags so Magpie settle() never collapses them.
  rows = [entry, entry2, entry3];
  const multi = await connect.sync();
  assert.equal(multi.connected, true);
  assert.equal(multi.count, 3);
  assert.equal(h.saved.size, 3);

  const key2 = `${POOL_PROVIDER}#${accountSlotTag(entry2.email)}`;
  const key3 = `${POOL_PROVIDER}#${accountSlotTag(entry3.email)}`;
  assert.equal(h.saved.has(POOL_PROVIDER), true);
  assert.equal(h.saved.has(key2), true);
  assert.equal(h.saved.has(key3), true);

  const labels = [...h.saved.values()].map((v) => v.accountId);
  const emails = [...h.saved.values()].map((v) => v.metadata.email);
  const slots = [...h.saved.values()].map((v) => v.metadata.poolSlot);
  assert.equal(new Set(labels).size, 3);
  assert.deepEqual(labels, emails);
  assert.equal(new Set(slots).size, 3);

  const dumped = JSON.stringify([...h.saved]);
  for (const item of rows) {
    assert(!dumped.includes(item.email));
    assert(!dumped.includes(item.password));
    assert(!dumped.includes(item.accessToken));
  }

  const plugin = await GPTFreePoolPlugin(h);
  const opts = await plugin.auth.loader(async () => h.saved.get(key2));
  assert.equal(opts.apiKey, POOL_MARKER);
});

test("partial and full account removal prunes only deleted Magpie account keys", async () => {
  const h = host();
  let rows = [entry, entry2];
  const connect = createPoolConnector(h.client, { poolRead: async () => rows });
  await connect.sync();
  const key2 = `${POOL_PROVIDER}#${accountSlotTag(entry2.email)}`;
  assert.equal(h.saved.has(POOL_PROVIDER), true);
  assert.equal(h.saved.has(key2), true);

  rows = [entry2];
  const partial = await connect.sync();
  assert.equal(partial.connected, true);
  assert.equal(partial.count, 1);
  assert.equal(h.saved.has(POOL_PROVIDER), false);
  assert.equal(h.saved.has(key2), true);

  rows = [];
  const empty = await connect.sync();
  assert.equal(empty.connected, false);
  assert.equal(empty.count, 0);
  assert.equal(h.saved.size, 0);
});

test("AsyncLocalStorage snapshot & claimKey prevent Magpie keyFor() scope redirection across accounts", async () => {
  const h = host();
  let rows = [entry];
  const connect = createPoolConnector(h.client, {
    poolRead: async () => rows,
    getActiveKey: () => h.magpie.account(POOL_PROVIDER) || "",
  });
  await connect.sync();
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolSlot, accountSlotTag(entry.email));

  // Trigger sync from inside an active scoped sign-in for entry2 on "gptfree-pool#custom2".
  rows = [entry, entry2, entry3];
  await h.scope.run({ provider: POOL_PROVIDER, key: `${POOL_PROVIDER}#custom2` }, async () => {
    connect.claimKey(entry2.email, `${POOL_PROVIDER}#custom2`);
    const res = await connect.sync();
    assert.equal(res.count, 3);
  });

  // Bare key still belongs to entry and wasn't overwritten with entry2, while custom2 got entry2 and entry3 got #slot3!
  assert.equal(h.saved.get(POOL_PROVIDER).metadata.poolSlot, accountSlotTag(entry.email));
  assert.equal(h.saved.get(`${POOL_PROVIDER}#custom2`).metadata.poolSlot, accountSlotTag(entry2.email));
  assert.equal(h.saved.get(`${POOL_PROVIDER}#${accountSlotTag(entry3.email)}`).metadata.poolSlot, accountSlotTag(entry3.email));

  // Removing entry while still inside custom2 scope defers removing bare key rather than redirecting to custom2.
  rows = [entry2, entry3];
  await h.scope.run({ provider: POOL_PROVIDER, key: `${POOL_PROVIDER}#custom2` }, async () => {
    await connect.sync();
  });
  assert.equal(h.saved.has(POOL_PROVIDER), true);
  assert.equal(h.saved.has(`${POOL_PROVIDER}#custom2`), true);

  // Once outside scope, deferred cleanup removes bare POOL_PROVIDER without touching custom2 or entry3.
  await connect.sync();
  assert.equal(h.saved.has(POOL_PROVIDER), false);
  assert.equal(h.saved.has(`${POOL_PROVIDER}#custom2`), true);
  assert.equal(h.saved.has(`${POOL_PROVIDER}#${accountSlotTag(entry3.email)}`), true);
});

test("slotsFile persists non-secret slot-to-key mappings across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "magpie-slots-test-"));
  const slotsFile = join(dir, "magpie-slots.json");
  try {
    const h = host();
    const rows = [entry, entry2];
    const c1 = createPoolConnector(h.client, { poolRead: async () => rows, slotsFile });
    c1.claimKey(entry.email, `${POOL_PROVIDER}#customA`);
    await c1.sync();
    const onDisk = await readFile(slotsFile, "utf8");
    assert(!onDisk.includes(entry.email));
    assert(!onDisk.includes(entry.password));
    assert(!onDisk.includes(entry.accessToken));
    const parsed = JSON.parse(onDisk);
    assert.equal(parsed.slots[accountSlotTag(entry.email)], `${POOL_PROVIDER}#customA`);

    const h2 = host();
    const c2 = createPoolConnector(h2.client, { poolRead: async () => rows, slotsFile });
    const res = await c2.sync();
    assert.equal(res.count, 2);
    assert.equal(h2.saved.has(`${POOL_PROVIDER}#customA`), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
