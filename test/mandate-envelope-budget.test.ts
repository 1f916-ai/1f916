// SEC-6 (GHSA-x2qr-jxw2-xf8h, tally-stick). A mandate envelope is the record's
// text locked to its owner, stored and served by the registry. The only volume
// limit was the per-account record COUNT (MANDATES_PER_DAY) and the per-envelope
// size (ENVELOPE_MAX), so one account could store ~MANDATES_PER_DAY * ENVELOPE_MAX
// (~64 MiB) of arbitrary bytes a day and the download was cached public. Now the
// day's envelope BYTES are capped (ENVELOPE_BYTES_PER_DAY) and the download is
// no-store.
//
// KILLING MUTATIONS:
//  - delete the envelope byte-budget check in createMandate -> "the 65th full
//    envelope is refused" goes red (it is accepted again).
//  - restore cache-control "public, max-age=300" on the envelope route in
//    src/index.ts -> "the download is no-store" goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createMandate, getEnvelope, ENVELOPE_MAX, ENVELOPE_BYTES_PER_DAY, STORED_ENVELOPE, envelopeKey } from "../src/mandates.ts";
import { SocietyError, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const te = new TextEncoder();
const T0 = 1_790_000_000_000;

function kvStub() {
  const m = new Map<string, string | Uint8Array>();
  return {
    m,
    async put(k: string, v: string | Uint8Array) { m.set(k, v); },
    async get(k: string, type?: string) {
      const v = m.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return (v instanceof Uint8Array ? v : te.encode(v)).buffer;
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    },
  };
}

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'reader', 'test-model', 'h1', 0, 0)`);
  const kv = kvStub();
  const e = { ...env, RECORDS: kv as unknown as KVNamespace } as Env;
  return { env: e, db, kv, citizen: { id: 1, handle: "reader" } as Citizen };
}

// Seed `n` prior envelope mandates for citizen 1, each `bytes` long, within the
// rolling day — directly, so the byte budget is at a known level without n real
// createMandate calls. Each needs a real seal row (the shim enforces FKs).
function seedEnvelopes(db: import("node:sqlite").DatabaseSync, n: number, bytes: number) {
  const seals: string[] = [];
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = i.toString(16).padStart(64, "0");
    seals.push(`(${200_000 + i}, 1, '${h}', 'mandate', ${T0 - 1000})`);
    rows.push(`(1, ${200_000 + i}, '${h}', 'ch${i}', '${"1".repeat(64)}', '${"2".repeat(64)}', 0, ${STORED_ENVELOPE}, ${bytes}, '', ${T0 - 1000})`);
  }
  db.exec(`INSERT INTO seals (id, citizen_id, hash, label, sealed_at) VALUES ${seals.join(",")}`);
  db.exec(`INSERT INTO mandates (citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, public, stored, envelope_bytes, label, created_at) VALUES ${rows.join(",")}`);
}

const fullEnvelope = btoa("\u0001".repeat(ENVELOPE_MAX)); // decodes to exactly ENVELOPE_MAX bytes
const privateBody = (envelope?: string) => ({ instruction_hash: "b".repeat(64), action_hash: "c".repeat(64), ...(envelope ? { envelope } : {}) });

test("the day's envelope bytes are capped: a full envelope is refused once the budget is spent", async () => {
  const { env, db, citizen } = fixture();
  // 64 full-size envelopes already spend exactly ENVELOPE_BYTES_PER_DAY.
  assert.equal(64 * ENVELOPE_MAX, ENVELOPE_BYTES_PER_DAY, "the budget is 64 full envelopes");
  seedEnvelopes(db, 64, ENVELOPE_MAX);
  await assert.rejects(
    createMandate(env, citizen, privateBody(fullEnvelope), T0),
    (e: unknown) => e instanceof SocietyError && e.status === 429 && /envelope byte budget/.test(e.message),
    "the 65th full envelope is over the byte budget and refused",
  );
});

test("the byte budget is inclusive at the boundary: the envelope that exactly fills it is accepted", async () => {
  const { env, db, citizen } = fixture();
  seedEnvelopes(db, 63, ENVELOPE_MAX); // 63 * ENVELOPE_MAX spent; one full envelope fits exactly
  const r = await createMandate(env, citizen, privateBody(fullEnvelope), T0);
  assert.ok(r.id > 0, "the envelope that brings the day's bytes to exactly the budget is accepted");
  assert.equal(r.stored.envelope, true);
});

test("the envelope byte budget does not block a mandate that carries no envelope", async () => {
  const { env, db, citizen } = fixture();
  seedEnvelopes(db, 64, ENVELOPE_MAX); // at the byte budget, but well under the 1,000 record budget
  const r = await createMandate(env, citizen, privateBody(), T0);
  assert.ok(r.id > 0, "an envelope-free mandate is governed by the record budget, not the byte budget");
  assert.equal(r.stored.envelope, false);
});

test("the envelope download is served no-store, not as a cacheable public asset", async () => {
  const { env, db, kv } = fixture();
  // Seed one mandate that has an envelope, and the bytes in the store.
  db.exec(`INSERT INTO seals (id, citizen_id, hash, label, sealed_at) VALUES (300000, 1, '${"d".repeat(64)}', 'mandate', ${T0 - 1000});
           INSERT INTO mandates (id, citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, public, stored, envelope_bytes, label, created_at)
             VALUES (7, 1, 300000, '${"d".repeat(64)}', 'ch', '${"1".repeat(64)}', '${"2".repeat(64)}', 0, ${STORED_ENVELOPE}, 9, '', ${T0 - 1000})`);
  await kv.put(envelopeKey(7), te.encode("ciphertext"));
  // getEnvelope resolves (sanity: the row + bytes are wired up).
  assert.equal(new TextDecoder().decode(await getEnvelope(env, 7)), "ciphertext");
  const res = await worker.fetch(new Request("https://1f916.ai/api/mandates/7/envelope", { headers: { "CF-Connecting-IP": "203.0.113.30" } }), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.equal(res.headers.get("cache-control"), "no-store", "the registry's domain must not cache arbitrary uploaded bytes");
});
