// A lapsed domain recovers only by POSTing its proof again. Updating that
// existing row consumes no slot in the five-domain registration budget.
// Real SQL and production schema; every domain/DNS response is synthetic.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { bindDomain, SocietyError, type Citizen } from "../src/society.ts";
import { BINDINGS_PER_CITIZEN } from "../src/bindings.ts";
import { b64urlEncode, jwkThumbprint } from "../src/keys.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
const thumbprint = await jwkThumbprint(publicKey);
const domain = "d1.example.test";

function fixture(count = BINDINGS_PER_CITIZEN) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'owner', 'test', 'h1', 0, 0), (2, 'other', 'test', 'h2', 0, 0)");
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (1, ?, ?, 'self', 'active', 0)")
    .run(publicKey, thumbprint);
  for (let id = 1; id <= count; id++) {
    db.prepare("INSERT INTO bindings (id, citizen_id, domain, method, key_thumbprint, status, verified_at, checked_at, created_at) VALUES (?, 1, ?, 'dns', 'old-thumbprint', 'lapsed', 0, 0, 0)")
      .run(id, `d${id}.example.test`);
  }
  return { env, db, citizen: { id: 1, handle: "owner" } as Citizen };
}

function state(db: DatabaseSync) {
  return {
    bindings: db.prepare("SELECT * FROM bindings ORDER BY id").all(),
    events: db.prepare("SELECT * FROM identity_events ORDER BY id").all(),
  };
}

function proofFetch(target: string, method: "dns" | "well-known" = "dns", h = "owner", k = thumbprint) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === `https://cloudflare-dns.com/dns-query?name=_1f916.${target}&type=TXT`) {
      return Response.json(method === "dns" ? { Answer: [{ data: `"v=1; h=${h}; k=${k}"` }] } : { Answer: [] });
    }
    assert.equal(url, `https://${target}/.well-known/1f916`, "no unplanned fetch, and never a real socket");
    return Response.json({ v: 1, h, k });
  };
}

for (const count of [BINDINGS_PER_CITIZEN - 1, BINDINGS_PER_CITIZEN]) {
  for (const method of ["dns", "well-known"] as const) {
    test(`a lapsed domain recovers via ${method} with ${count} stored domains`, async (t) => {
      const { env, db, citizen } = fixture(count);
      t.after(() => db.close());
      t.mock.method(globalThis, "fetch", proofFetch(domain, method));
      const before = state(db).bindings;
      const result = await bindDomain(env, citizen, { domain });
      assert.equal(result.bound, true);
      assert.equal(result.domain, domain);
      assert.equal(result.method, method);
      const after = state(db);
      assert.equal(after.bindings.length, count, "recovery must not consume a registration slot");
      assert.deepEqual(after.bindings.slice(1), before.slice(1), "other bindings stay untouched");
      const row = after.bindings[0];
      assert.equal(row.id, 1);
      assert.equal(row.created_at, 0);
      assert.equal(row.citizen_id, 1);
      assert.equal(row.status, "verified");
      assert.equal(row.key_thumbprint, thumbprint, "record the key the domain actually named");
      assert.equal(row.method, method);
      assert.ok(Number(row.verified_at) > 0);
      assert.equal(row.checked_at, row.verified_at);
      assert.equal(after.events.length, 1);
      assert.equal(after.events[0].kind, "binding-verified");
      assert.equal(after.events[0].hash, result.chained);
    });
  }
}

test("a new domain at capacity is refused before any probe and writes nothing", async (t) => {
  const { env, db, citizen } = fixture();
  t.after(() => db.close());
  const probe = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not probe a sixth domain"); });
  const before = state(db);
  await assert.rejects(bindDomain(env, citizen, { domain: "new.example.test" }),
    (e: unknown) => e instanceof SocietyError && e.status === 429 && e.message === `at most ${BINDINGS_PER_CITIZEN} bound domains per citizen`);
  assert.equal(probe.mock.callCount(), 0);
  assert.deepEqual(state(db), before);
});

test("a new domain below capacity still inserts one row and one chained event", async (t) => {
  const { env, db, citizen } = fixture(BINDINGS_PER_CITIZEN - 1);
  t.after(() => db.close());
  const target = "new.example.test";
  t.mock.method(globalThis, "fetch", proofFetch(target));
  const result = await bindDomain(env, citizen, { domain: target });
  const after = state(db);
  assert.equal(after.bindings.length, BINDINGS_PER_CITIZEN);
  assert.equal(after.bindings.at(-1)?.domain, target);
  assert.equal(after.events.length, 1);
  assert.equal(after.events[0].hash, result.chained);
});

for (const c of [
  { name: "revoked key", status: 400, handle: "owner", key: thumbprint },
  { name: "wrong handle", status: 422, handle: "other", key: thumbprint },
  { name: "unbound thumbprint", status: 422, handle: "owner", key: "not-a-bound-thumbprint" },
  { name: "another owner's domain", status: 409, handle: "owner", key: thumbprint },
]) {
  test(`recovery at capacity still refuses ${c.name} without writes`, async (t) => {
    const { env, db, citizen } = fixture();
    t.after(() => db.close());
    const target = c.name === "another owner's domain" ? "foreign.example.test" : domain;
    if (c.name === "revoked key") db.exec("UPDATE keys SET status = 'revoked'");
    if (c.name === "another owner's domain") {
      db.prepare("INSERT INTO bindings (citizen_id, domain, method, key_thumbprint, status, verified_at, checked_at, created_at) VALUES (2, ?, 'dns', ?, 'lapsed', 0, 0, 0)")
        .run(target, thumbprint);
    }
    const probe = t.mock.method(globalThis, "fetch", proofFetch(target, "dns", c.handle, c.key));
    const before = state(db);
    await assert.rejects(bindDomain(env, citizen, { domain: target }),
      (e: unknown) => e instanceof SocietyError && e.status === c.status);
    if (c.name === "revoked key") assert.equal(probe.mock.callCount(), 0);
    assert.deepEqual(state(db), before);
  });
}
