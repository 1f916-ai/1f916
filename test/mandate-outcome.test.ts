// What came of it, added to a record afterwards (addOutcome, src/mandates.ts):
// POST /api/mandates/:id/outcome and the record_outcome tool.
//
// The promise is that a record is never edited. So adding an outcome must
// leave the record's own commit exactly as it was sealed, must happen once,
// and must be the owner's alone. Each test names the line it is there to catch.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   O1  drop the owner check                                   -> "only the citizen who made the record can add to it"
//   O2  drop the recorded-with-outcome refusal                  -> "a record made with its outcome refuses another"
//   O3  drop the already-has-one check                          -> "an outcome is added once" (a seal is made before the primary key refuses)
//   O3b drop PRIMARY KEY from mandate_outcomes.mandate_id       -> "an outcome is added once" (the database holds a second row)
//   O4  write outcome_hash into the mandates row                -> "the record's own commit is unchanged by the outcome"
//   O5  change outcomeCommitPayload's prefix or field order     -> "the outcome's commit names the record and the record's commit"
//   O6  drop the `m.public === 1` gate before storing text      -> "a private record's outcome text is never stored"
//   O7  drop the OUTCOMES_PER_DAY check                         -> "the daily budget refuses the next outcome"
//   O8  drop the LEFT JOIN columns from the list statement      -> "the list and the page carry the added outcome"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { addOutcome, createMandate, getMandate, listMandates, mandatePage, sha256Hex, outcomeCommitPayload, commitPayload, OUTCOMES_PER_DAY, textKey } from "../src/mandates.ts";
import { SocietyError, sealMemory, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const te = new TextEncoder();
const T0 = 1_790_000_000_000;
const MIN = 60_000;

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
  return { env: e, db, kv, citizen: { id: 1, handle: "reader" } as Citizen, other: { id: 2, handle: "other" } as Citizen };
}

async function refused(p: Promise<unknown>, status: number, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SocietyError, String(e));
    assert.equal(e.status, status, e.message);
    assert.match(e.message, re);
    return true;
  });
}

test("the outcome's commit names the record and the record's commit, and is sealed on its own", async () => {
  const { env, db, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "swap 1 USDC to BNKR", action: "bankr wallet swap --amount 1", public: true }, T0);
  const o = await addOutcome(env, citizen, m.id, { outcome: "confirmed 0xabc" }, T0 + 5 * MIN);
  const oh = await sha256Hex("confirmed 0xabc");
  assert.equal(o.outcome_hash, oh);
  // Pinned as a literal, not recomputed through the module.
  assert.equal(o.commit_payload, `1f916.mandate.outcome.v1:reader:${T0 + 5 * MIN}:${m.id}:${m.commit}:${oh}`);
  assert.equal(outcomeCommitPayload("reader", T0 + 5 * MIN, m.id, m.commit, oh), o.commit_payload);
  assert.equal(o.commit, await sha256Hex(o.commit_payload));
  assert.equal(o.mandate_commit, m.commit);
  assert.notEqual(o.seal.id, m.seal.id, "a second seal, not the record's own");
  const seal = db.prepare("SELECT label, hash FROM seals WHERE id = ?").get(o.seal.id) as { label: string; hash: string };
  assert.deepEqual({ ...seal }, { label: "mandate", hash: o.commit });
  const ev = db.prepare("SELECT id, kind FROM identity_events WHERE hash = ?").get(o.seal.chained) as { id: number; kind: string };
  assert.equal(ev.kind, "memory.seal");
  const first = db.prepare("SELECT id FROM identity_events WHERE hash = ?").get(m.seal.chained) as { id: number };
  assert.ok(ev.id > first.id, "the outcome's event comes after the record's in the chain");
});

test("the record's own commit is unchanged by the outcome", async () => {
  const { env, db, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  const before = { ...(db.prepare("SELECT * FROM mandates WHERE id = ?").get(m.id) as Record<string, unknown>) };
  await addOutcome(env, citizen, m.id, { outcome: "done" }, T0 + MIN);
  const after = { ...(db.prepare("SELECT * FROM mandates WHERE id = ?").get(m.id) as Record<string, unknown>) };
  assert.deepEqual(after, before, "the mandates row is never touched");
  const got = (await getMandate(env, m.id)) as Record<string, unknown>;
  assert.equal(got.outcome_hash, null, "outcome_hash is the outcome the record was MADE with");
  assert.equal(got.commit, m.commit);
  assert.equal(got.commit_payload, commitPayload("reader", T0, m.instruction_hash, m.action_hash, null));
  assert.equal(await sha256Hex(got.commit_payload as string), got.commit, "and the payload still hashes to the sealed commit");
  assert.equal(got.has_outcome, true);
});

test("only the citizen who made the record can add to it", async () => {
  const { env, db, citizen, other } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  await refused(addOutcome(env, other, m.id, { outcome: "not mine" }, T0 + MIN), 403, /only the citizen who recorded mandate/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_outcomes").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE citizen_id = 2").get() as { n: number }).n, 0, "and nothing was sealed for the stranger");
});

test("a record made with its outcome refuses another", async () => {
  const { env, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b", outcome: "c" }, T0);
  await refused(addOutcome(env, citizen, m.id, { outcome: "d" }, T0 + MIN), 409, /was recorded with its outcome/);
  const got = (await getMandate(env, m.id)) as Record<string, unknown>;
  assert.equal(got.outcome_added, null);
  assert.equal(got.has_outcome, true);
});

test("an outcome is added once", async () => {
  const { env, db, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  await addOutcome(env, citizen, m.id, { outcome: "first" }, T0 + MIN);
  const sealsBefore = (db.prepare("SELECT COUNT(*) AS n FROM seals WHERE citizen_id = 1").get() as { n: number }).n;
  await refused(addOutcome(env, citizen, m.id, { outcome: "second" }, T0 + 2 * MIN), 409, /already has an outcome/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE citizen_id = 1").get() as { n: number }).n, sealsBefore, "the refusal came before anything was sealed");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_outcomes WHERE mandate_id = ?").get(m.id) as { n: number }).n, 1);
  assert.equal(((await getMandate(env, m.id)) as { outcome_added: { outcome_hash: string } }).outcome_added.outcome_hash, await sha256Hex("first"));
  // And the database itself cannot hold a second one, whatever the code does.
  // The row below is valid in every other respect (a real seal of this
  // citizen's, a fresh commit), so the ONLY thing it can fail on is the
  // mandate already having a row. A foreign key refusing it would prove nothing.
  const spare = await sealMemory(env, citizen, { hash: "5".repeat(64), label: "spare" });
  assert.ok(spare.sealed && typeof spare.id === "number");
  assert.throws(
    () => db.exec(`INSERT INTO mandate_outcomes (mandate_id, citizen_id, seal_id, commit_hash, chained, outcome_hash, stored, created_at) VALUES (${m.id}, 1, ${spare.id}, '${"f".repeat(64)}', 'x', '${"e".repeat(64)}', 0, 1)`),
    /mandate_outcomes\.mandate_id/,
  );
});

test("a private record's outcome text is never stored; a public record's is", async () => {
  const { env, kv, citizen } = fixture();
  const priv = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  const po = await addOutcome(env, citizen, priv.id, { outcome: "secret result" }, T0 + MIN);
  assert.equal(po.stored, false);
  assert.equal(kv.m.has(textKey(po.outcome_hash)), false, "the text was hashed and dropped");
  const gp = (await getMandate(env, priv.id)) as { outcome_added: { outcome: unknown; stored: boolean } };
  assert.equal(gp.outcome_added.stored, false);
  assert.equal(gp.outcome_added.outcome, null);

  const pub = await createMandate(env, citizen, { instruction: "c", action: "d", public: true }, T0 + 2 * MIN);
  const uo = await addOutcome(env, citizen, pub.id, { outcome: "confirmed 0xdef" }, T0 + 3 * MIN);
  assert.equal(uo.stored, true);
  assert.equal(kv.m.get(textKey(uo.outcome_hash)), "confirmed 0xdef");
  const gu = (await getMandate(env, pub.id)) as { outcome_added: { outcome: unknown; event_id: unknown; proof: unknown } };
  assert.equal(gu.outcome_added.outcome, "confirmed 0xdef");
  assert.ok(typeof gu.outcome_added.event_id === "number");
  assert.equal(gu.outcome_added.proof, `/api/proof?log=identity_events&event=${gu.outcome_added.event_id}`);

  // A fingerprint alone is accepted on either, and nothing is stored for it.
  const third = await createMandate(env, citizen, { instruction: "e", action: "f", public: true }, T0 + 4 * MIN);
  const ho = await addOutcome(env, citizen, third.id, { outcome_hash: "9".repeat(64) }, T0 + 5 * MIN);
  assert.equal(ho.stored, false);
});

test("validation: the id, the mandate, text or hash but not both, and the hash's shape", async () => {
  const { env, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  await refused(addOutcome(env, citizen, NaN, { outcome: "x" }, T0), 400, /id is required/);
  await refused(addOutcome(env, citizen, 4242, { outcome: "x" }, T0), 404, /no mandate 4242/);
  await refused(addOutcome(env, citizen, m.id, {}, T0), 400, /outcome is required/);
  await refused(addOutcome(env, citizen, m.id, { outcome: "x", outcome_hash: "a".repeat(64) }, T0), 400, /not both/);
  await refused(addOutcome(env, citizen, m.id, { outcome_hash: "zz" }, T0), 400, /64 hex/);
});

test("the daily budget refuses the next outcome", async () => {
  const { env, db, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "a", action: "b" }, T0);
  // Fill the window directly: the budget counts rows, and a thousand sealed
  // outcomes would make this test about the chain's speed, not the budget.
  const ins = db.prepare("INSERT INTO mandate_outcomes (mandate_id, citizen_id, seal_id, commit_hash, chained, outcome_hash, stored, created_at) VALUES (?, 1, ?, ?, 'x', ?, 0, ?)");
  db.exec("PRAGMA foreign_keys = OFF");
  for (let i = 0; i < OUTCOMES_PER_DAY; i++) ins.run(1_000_000 + i, 2_000_000 + i, i.toString(16).padStart(64, "0"), "a".repeat(64), T0 + MIN);
  await refused(addOutcome(env, citizen, m.id, { outcome: "one too many" }, T0 + 2 * MIN), 429, /outcome budget spent/);
  // A day later the window has moved on.
  const late = await addOutcome(env, citizen, m.id, { outcome: "next day" }, T0 + MIN + 86_400_000 + 1);
  assert.equal(late.mandate, m.id);
});

test("the list and the page carry the added outcome", async () => {
  const { env, citizen } = fixture();
  const m = await createMandate(env, citizen, { instruction: "told", action: "did", public: true }, T0);
  const bare = await createMandate(env, citizen, { instruction: "told 2", action: "did 2", public: true }, T0 + MIN);
  const o = await addOutcome(env, citizen, m.id, { outcome: "came of it" }, T0 + 2 * MIN);
  for (const list of [await listMandates(env, "reader", undefined), await listMandates(env, null, undefined)]) {
    const rows = list.mandates as { id: number; has_outcome: boolean; outcome_added: { commit: string; outcome_hash: string } | null }[];
    const withOne = rows.find((r) => r.id === m.id)!;
    assert.equal(withOne.has_outcome, true);
    assert.equal(withOne.outcome_added?.commit, o.commit);
    assert.equal(withOne.outcome_added?.outcome_hash, o.outcome_hash);
    const without = rows.find((r) => r.id === bare.id)!;
    assert.equal(without.has_outcome, false);
    assert.equal(without.outcome_added, null);
  }
  const page = await mandatePage(env, m.id);
  assert.match(page, /What came of it/);
  assert.match(page, /came of it<\/pre>/);
  assert.match(page, /after the instruction and the action above were sealed/);
  assert.match(page, /The first two fingerprints above were combined/);
  assert.ok(page.includes(o.commit), "the page shows the outcome's own commit");
  const barePage = await mandatePage(env, bare.id);
  assert.doesNotMatch(barePage, /What came of it/);
  assert.match(barePage, /The two fingerprints above were combined/);
});

test("over HTTP and over MCP: 201 with a bearer, 401 without, and the tool lands on the same record", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const e = { ...env, RECORDS: kvStub() as unknown as KVNamespace } as Env;
  const post = (path: string, body: unknown, secret?: string) =>
    worker.fetch(new Request(`https://1f916.ai${path}`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.9", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) }), e);
  const reg = await post("/api/register", { handle: "http-keeper", model: "test-model" });
  assert.equal(reg.status, 201);
  const { secret } = (await reg.json()) as { secret: string };
  const made = (await (await post("/api/mandates", { instruction_hash: "1".repeat(64), action_hash: "2".repeat(64) }, secret)).json()) as { id: number };
  assert.equal((await post(`/api/mandates/${made.id}/outcome`, { outcome_hash: "3".repeat(64) })).status, 401);
  const added = await post(`/api/mandates/${made.id}/outcome`, { outcome_hash: "3".repeat(64) }, secret);
  assert.equal(added.status, 201, await added.clone().text());
  assert.equal(((await added.json()) as { mandate: number }).mandate, made.id);
  assert.equal((await post(`/api/mandates/${made.id}/outcome`, { outcome_hash: "4".repeat(64) }, secret)).status, 409);

  const second = (await (await post("/api/mandates", { instruction_hash: "5".repeat(64), action_hash: "6".repeat(64) }, secret)).json()) as { id: number };
  const rpc = await worker.fetch(
    new Request("https://1f916.ai/mcp/protocol", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_outcome", arguments: { id: second.id, outcome_hash: "7".repeat(64) } } }),
    }),
    e,
  );
  const res = (await rpc.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(res.result.isError, true, res.result.content[0].text);
  assert.equal(JSON.parse(res.result.content[0].text).mandate, second.id);
  const read = (await (await worker.fetch(new Request(`https://1f916.ai/api/mandates/${second.id}`), e)).json()) as { outcome_added: { outcome_hash: string } };
  assert.equal(read.outcome_added.outcome_hash, "7".repeat(64));
});
