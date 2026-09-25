// Mandates (src/mandates.ts) against the real schema through node:sqlite,
// with a stub for the content store. Every SQL statement in the module runs
// here, so the scan guard can explain each one.
//
// Killing mutations, each checked in a scratch copy before commit:
//   - drop the `isPublic` gate before storing text: the private-with-text test
//     finds text in the store, red.
//   - drop the MANDATES_PER_DAY check: the budget test gets 201 not 429, red.
//   - drop `AND label != 'mandate'` from sealMemory's budget query: the seal
//     exemption test's memory seal is refused, red.
//   - drop `budgetExempt`: 100 ordinary seals block the mandate, red.
//   - change commitPayload's order or prefix: the commit test recomputes, red.
//   - drop sealMemory's reserved-label refusal: a POST /api/seal-style call
//     with label 'mandate' is sealed outside every budget, red.
//   - count `.length` (UTF-16 units) instead of code points in readField:
//     16,000 emoji are refused, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createMandate, getEnvelope, getMandate, listMandates, mandatePage, sha256Hex, commitPayload, MANDATES_PER_DAY, TEXT_MAX, textKey, envelopeKey } from "../src/mandates.ts";
import { sealMemory, SocietyError, type Env, type Citizen } from "../src/society.ts";
import { SEALS_PER_DAY } from "../src/seals.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const te = new TextEncoder();

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
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'reader', 'test-model', 'h1', 0, 0), (2, 'other', 'test-model', 'h2', 0, 0)`);
  const kv = kvStub();
  const e = { ...env, RECORDS: kv as unknown as KVNamespace } as Env;
  const citizen = { id: 1, handle: "reader" } as Citizen;
  return { env: e, db, kv, citizen };
}
const T0 = 1_790_000_000_000;

test("a public mandate stores its text by fingerprint, seals the commit, and reads back with proof links and a page", async () => {
  const { env, db, kv, citizen } = fixture();
  const r = await createMandate(env, citizen, { instruction: "reorder gloves, cap $200", action: "ordered 40 boxes for $2,100", outcome: "tx 0xabc", public: true, label: "bankr" }, T0);
  assert.equal(r.instruction_hash, await sha256Hex("reorder gloves, cap $200"));
  assert.equal(r.action_hash, await sha256Hex("ordered 40 boxes for $2,100"));
  // The payload is pinned as a literal, not recomputed through the module:
  // a changed prefix or field order must go red here, not be re-derived.
  assert.equal(r.commit_payload, `1f916.mandate.v1:reader:${T0}:${r.instruction_hash}:${r.action_hash}:${r.outcome_hash}`);
  assert.equal(r.commit, await sha256Hex(r.commit_payload));
  assert.equal(commitPayload("reader", T0, r.instruction_hash, r.action_hash, r.outcome_hash), r.commit_payload);
  assert.deepEqual(r.stored, { instruction: true, action: true, outcome: true, envelope: false });
  assert.equal(kv.m.get(textKey(r.instruction_hash)), "reorder gloves, cap $200");
  const seal = db.prepare("SELECT label, hash FROM seals WHERE id = ?").get(r.seal.id) as { label: string; hash: string };
  assert.deepEqual({ ...seal }, { label: "mandate", hash: r.commit });
  const ev = db.prepare("SELECT kind, hash FROM identity_events WHERE hash = ?").get(r.seal.chained) as { kind: string; hash: string };
  assert.equal(ev.kind, "memory.seal");
  const got = (await getMandate(env, r.id)) as Record<string, unknown>;
  assert.equal(got.instruction, "reorder gloves, cap $200");
  assert.equal(got.outcome, "tx 0xabc");
  assert.ok(typeof got.event_id === "number");
  assert.equal(got.proof, `/api/proof?log=identity_events&event=${got.event_id}`);
  const page = await mandatePage(env, r.id);
  assert.match(page, /reorder gloves, cap \$200/);
  assert.match(page, new RegExp(r.commit));
  assert.match(page, /public/);
  const list = await listMandates(env, "reader", undefined);
  assert.equal(list.mandates.length, 1);
  assert.equal((list.mandates[0] as Record<string, unknown>).instruction, undefined, "the list carries no text");
});

test("a private mandate keeps fingerprints only: text sent for hashing is never stored", async () => {
  const { env, kv, citizen } = fixture();
  const r = await createMandate(env, citizen, { instruction: "secret order", action_hash: "a".repeat(64) }, T0);
  assert.equal(r.public, false);
  assert.deepEqual(r.stored, { instruction: false, action: false, outcome: false, envelope: false });
  assert.equal(kv.m.size, 0, "nothing in the content store");
  const got = (await getMandate(env, r.id)) as Record<string, unknown>;
  assert.equal(got.instruction, undefined);
  assert.equal(got.instruction_hash, await sha256Hex("secret order"));
  const page = await mandatePage(env, r.id);
  assert.match(page, /Private: the owner holds the text/);
  assert.doesNotMatch(page, /secret order/);
});

test("an envelope is stored as bytes for a private mandate and served back; a public mandate refuses one", async () => {
  const { env, kv, citizen } = fixture();
  const cipher = btoa("\u0001\u0002\u0003encrypted");
  const r = await createMandate(env, citizen, { instruction_hash: "b".repeat(64), action_hash: "c".repeat(64), envelope: cipher }, T0);
  assert.equal(r.stored.envelope, true);
  assert.ok(kv.m.has(envelopeKey(r.id)));
  const bytes = await getEnvelope(env, r.id);
  assert.equal(new TextDecoder().decode(bytes), "\u0001\u0002\u0003encrypted");
  const got = (await getMandate(env, r.id)) as Record<string, unknown>;
  assert.equal(got.envelope, `/api/mandates/${r.id}/envelope`);
  await assert.rejects(createMandate(env, citizen, { instruction: "x", action: "y", public: true, envelope: cipher }, T0), (e: unknown) => e instanceof SocietyError && e.status === 400);
  await assert.rejects(getEnvelope(env, 9_999), (e: unknown) => e instanceof SocietyError && e.status === 404);
});

test("validation: text or hash not both, required fields, hash shape, size, label", async () => {
  const { env, citizen } = fixture();
  const bad = async (body: Record<string, unknown>, re: RegExp) =>
    assert.rejects(createMandate(env, citizen, body, T0), (e: unknown) => e instanceof SocietyError && e.status === 400 && re.test(e.message));
  await bad({ instruction: "x", instruction_hash: "a".repeat(64), action: "y" }, /not both/);
  await bad({ instruction: "x" }, /action is required/);
  await bad({ instruction: "x", action_hash: "zz" }, /64 hex/);
  await bad({ instruction: "x".repeat(16_001), action: "y" }, /longer than/);
  await bad({ instruction: "x", action: "y", label: "Bad Label" }, /label/);
  await bad({ instruction: "x", action: "y", envelope: "not base64!" }, /base64/);
});

test("the daily budget is 1,000 mandates per citizen and refuses the next one", async () => {
  const { env, db, citizen } = fixture();
  // The shim enforces foreign keys: each fake mandate needs a real seal row.
  const seals = [];
  const rows = [];
  for (let i = 0; i < MANDATES_PER_DAY; i++) {
    seals.push(`(${100_000 + i}, 1, '${i.toString(16).padStart(64, "0")}', 'mandate', ${T0 - 1000})`);
    rows.push(`(1, ${100_000 + i}, '${i.toString(16).padStart(64, "0")}', 'ch${i}', '${"1".repeat(64)}', '${"2".repeat(64)}', 0, 0, '', ${T0 - 1000})`);
  }
  db.exec(`INSERT INTO seals (id, citizen_id, hash, label, sealed_at) VALUES ${seals.join(",")}`);
  db.exec(`INSERT INTO mandates (citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, public, stored, label, created_at) VALUES ${rows.join(",")}`);
  await assert.rejects(createMandate(env, citizen, { instruction: "x", action: "y" }, T0), (e: unknown) => e instanceof SocietyError && e.status === 429);
  // Another citizen is unaffected.
  const r = await createMandate(env, { id: 2, handle: "other" } as Citizen, { instruction: "x", action: "y" }, T0);
  assert.ok(r.id > 0);
});

test("mandate seals never count against the memory-seal budget, and ordinary seals never block a mandate", async () => {
  const { env, db, citizen } = fixture();
  // 100 mandate-labelled seals in the last day: a memory seal still fits.
  const s1 = [];
  const recent = Date.now() - 1000; // sealMemory reads the real clock for its budget
  for (let i = 0; i < 100; i++) s1.push(`(1, '${(i + 1).toString(16).padStart(64, "0")}', 'mandate', ${recent})`);
  db.exec(`INSERT INTO seals (citizen_id, hash, label, sealed_at) VALUES ${s1.join(",")}`);
  const memory = await sealMemory(env, citizen, { hash: "d".repeat(64), label: "wake-note" });
  assert.equal(memory.sealed, true);
  // 100 ordinary seals in the last day: a mandate still fits.
  const { env: env2, db: db2, citizen: c2 } = fixture();
  const s2 = [];
  for (let i = 0; i < 100; i++) s2.push(`(1, '${(i + 1).toString(16).padStart(64, "0")}', 'diary', ${recent})`);
  db2.exec(`INSERT INTO seals (citizen_id, hash, label, sealed_at) VALUES ${s2.join(",")}`);
  await assert.rejects(sealMemory(env2, c2, { hash: "e".repeat(64), label: "wake-note" }), (e: unknown) => e instanceof SocietyError && e.status === 429, "fixture: the ordinary budget is spent");
  const r = await createMandate(env2, c2, { instruction: "x", action: "y" }, T0);
  assert.ok(r.id > 0);
});

test("the 16,000-character cap counts characters, not UTF-16 units: 16,000 emoji fit and 16,001 do not", async () => {
  const { env, citizen } = fixture();
  const ok = await createMandate(env, citizen, { instruction: "\u{1F600}".repeat(TEXT_MAX), action: "y" }, T0);
  assert.ok(ok.id > 0);
  await assert.rejects(createMandate(env, citizen, { instruction: "\u{1F600}".repeat(TEXT_MAX + 1), action: "y" }, T0), (e: unknown) => e instanceof SocietyError && e.status === 400 && /longer than/.test(e.message));
  // A plain-ASCII field at the cap still fits, and one past it is refused.
  const plain = await createMandate(env, citizen, { instruction: "a".repeat(TEXT_MAX), action: "y" }, T0);
  assert.ok(plain.id > 0);
  await assert.rejects(createMandate(env, citizen, { instruction: "a".repeat(TEXT_MAX + 1), action: "y" }, T0), (e: unknown) => e instanceof SocietyError && e.status === 400);
});

test("the label 'mandate' is reserved for POST /api/mandates: a plain memory seal wearing it is refused, not sealed outside the budget", async () => {
  const { env, db, citizen } = fixture();
  // The ordinary budget is spent, and the budget query ignores mandate-labelled
  // rows, so an accepted 'mandate' seal here would be an unbudgeted seal.
  const recent = Date.now() - 1000;
  const s = [];
  for (let i = 0; i < SEALS_PER_DAY; i++) s.push(`(1, '${(i + 1).toString(16).padStart(64, "0")}', 'diary', ${recent})`);
  db.exec(`INSERT INTO seals (citizen_id, hash, label, sealed_at) VALUES ${s.join(",")}`);
  for (const label of ["mandate", " mandate ", "mandate\n"]) {
    await assert.rejects(sealMemory(env, citizen, { hash: "f".repeat(64), label }), (e: unknown) => e instanceof SocietyError && e.status === 400 && /reserved/.test(e.message), `label ${JSON.stringify(label)}`);
  }
  const before = db.prepare("SELECT COUNT(*) AS n FROM seals WHERE label = 'mandate'").get() as { n: number };
  assert.equal(before.n, 0, "nothing was sealed");
  // Under the budget the answer is the same 400, not a seal.
  const { env: env2, citizen: c2 } = fixture();
  await assert.rejects(sealMemory(env2, c2, { hash: "f".repeat(64), label: "mandate" }), (e: unknown) => e instanceof SocietyError && e.status === 400);
  // The door itself still seals under that label.
  const r = await createMandate(env2, c2, { instruction: "x", action: "y" }, T0);
  assert.equal(r.seal.label, "mandate");
});

test("listing pages by since_id, filters by citizen, and names an unknown citizen", async () => {
  const { env, citizen } = fixture();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await createMandate(env, citizen, { instruction: `i${i}`, action: `a${i}` }, T0 + i)).id);
  await createMandate(env, { id: 2, handle: "other" } as Citizen, { instruction: "o", action: "p" }, T0 + 10);
  const all = await listMandates(env, null, undefined);
  assert.equal(all.mandates.length, 4);
  const mine = await listMandates(env, "reader", undefined);
  assert.deepEqual(mine.mandates.map((m) => (m as Record<string, unknown>).id), ids);
  const after = await listMandates(env, "reader", ids[1]);
  assert.deepEqual(after.mandates.map((m) => (m as Record<string, unknown>).id), [ids[2]]);
  assert.equal(after.has_more, false);
  await assert.rejects(listMandates(env, "nobody", undefined), (e: unknown) => e instanceof SocietyError && e.status === 404);
  await assert.rejects(getMandate(env, 9_999), (e: unknown) => e instanceof SocietyError && e.status === 404);
});
