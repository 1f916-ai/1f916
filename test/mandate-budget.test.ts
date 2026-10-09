// The daily mandate budget of a named account, and many records in one request
// (setMandateBudget, budgetFor, createMandateBatch in src/mandates.ts).
//
// A company recording for all of its users needs more than the default. The
// promise to everyone else is that a budget is never raised quietly: only the
// maintainer sets one, with a reason, and every one that was ever set is
// public and sealed.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   B1  drop the maintainer check                       -> "only the maintainer sets a budget"
//   B2  budgetFor always answers the default             -> "a set budget is the account's budget, for mandates and for outcomes"
//   B3  budgetFor reads the OLDEST row                   -> "the newest row is the budget and the older ones are its history"
//   B4  outcomes keep the default                        -> "a set budget is the account's budget, for mandates and for outcomes"
//   B5  accept a budget with no reason                   -> "a budget needs an account, a number in range and a reason"
//   B6  seal something other than the budget's commit    -> "every budget is sealed into the maintainer's chain and listed for anyone"
//   B7  accept a batch of 26                             -> "a batch carries 1 to 25 records"
//   B8  let one refusal abort the batch                  -> "one refused record does not undo the others"
//   B9  give every record in a batch the same instant    -> "identical records in one batch are each recorded"
//   B10 let a batch skip the budget                      -> "a batch spends the budget record by record"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { addOutcome, budgetCommitPayload, budgetFor, createMandate, createMandateBatch, listMandateBudgets, setMandateBudget, sha256Hex, BATCH_MAX, BUDGET_MAX, MANDATES_PER_DAY } from "../src/mandates.ts";
import { MAINTAINER_ID, SocietyError, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T0 = 1_790_000_000_000;
const H = (c: string) => c.repeat(64);

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0), (2, 'bank', 'test-model', 'h2', 0, 0), (3, 'other', 'test-model', 'h3', 0, 0)`);
  const kv = new Map<string, unknown>();
  const e = { ...env, RECORDS: { put: async (k: string, v: unknown) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null } as unknown as KVNamespace } as Env;
  // Fill an account's rolling day without sealing a thousand records.
  const fill = (table: "mandates" | "mandate_outcomes", citizenId: number, n: number, at: number, base: number) => {
    db.exec("PRAGMA foreign_keys = OFF");
    const stmt =
      table === "mandates"
        ? db.prepare("INSERT INTO mandates (citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, public, stored, label, created_at) VALUES (?, ?, ?, 'x', ?, ?, 0, 0, '', ?)")
        : db.prepare("INSERT INTO mandate_outcomes (mandate_id, citizen_id, seal_id, commit_hash, chained, outcome_hash, stored, created_at) VALUES (?, ?, ?, ?, 'x', ?, 0, ?)");
    for (let i = 0; i < n; i++) {
      const k = base + i;
      const commit = k.toString(16).padStart(64, "0");
      if (table === "mandates") stmt.run(citizenId, k, commit, H("a"), H("b"), at);
      else stmt.run(k, citizenId, k, commit, H("c"), at);
    }
    db.exec("PRAGMA foreign_keys = ON");
  };
  return { env: e, db, fill, keeper: { id: 1, handle: "keeper" } as Citizen, bank: { id: 2, handle: "bank" } as Citizen, other: { id: 3, handle: "other" } as Citizen };
}

async function refused(p: Promise<unknown>, status: number, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SocietyError, String(e));
    assert.equal(e.status, status, e.message);
    assert.match(e.message, re);
    return true;
  });
}

test("only the maintainer sets a budget", async () => {
  const { env, db, keeper, bank } = fixture();
  assert.equal(keeper.id, MAINTAINER_ID);
  await refused(setMandateBudget(env, bank, { handle: "bank", per_day: 50_000, reason: "I would like more" }, T0), 403, /only the maintainer sets a mandate budget/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_budgets").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, 0);
  assert.equal(await budgetFor(env, bank.id), MANDATES_PER_DAY);
});

test("a budget needs an account, a number in range and a reason", async () => {
  const { env, db, keeper } = fixture();
  assert.equal(BUDGET_MAX, 1_000_000);
  await refused(setMandateBudget(env, keeper, { per_day: 5000, reason: "r" }, T0), 400, /handle is required/);
  await refused(setMandateBudget(env, keeper, { handle: "nobody-here", per_day: 5000, reason: "r" }, T0), 404, /no citizen/);
  for (const bad of [0, -1, 1.5, BUDGET_MAX + 1, "5000", null, undefined, NaN, Infinity]) {
    await refused(setMandateBudget(env, keeper, { handle: "bank", per_day: bad, reason: "r" }, T0), 400, /per_day must be a whole number from 1 to 1000000/);
  }
  for (const bad of ["", "   ", undefined, 7, "x".repeat(501)]) {
    await refused(setMandateBudget(env, keeper, { handle: "bank", per_day: 5000, reason: bad }, T0), 400, /reason is required/);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandate_budgets").get() as { n: number }).n, 0);
  assert.equal((await setMandateBudget(env, keeper, { handle: "bank", per_day: BUDGET_MAX, reason: "x".repeat(500) }, T0)).per_day, BUDGET_MAX);
});

test("a set budget is the account's budget, for mandates and for outcomes", async () => {
  const { env, fill, keeper, bank, other } = fixture();
  const first = await createMandate(env, bank, { instruction_hash: H("1"), action_hash: H("2") }, T0);
  fill("mandates", bank.id, MANDATES_PER_DAY - 1, T0 + 1, 5_000_000);
  await refused(createMandate(env, bank, { instruction_hash: H("1"), action_hash: H("2") }, T0 + 2), 429, /mandate budget spent \(1000\/rolling 24h\)/);

  const set = await setMandateBudget(env, keeper, { handle: "bank", per_day: 1500, reason: "records for all of its users" }, T0 + 3);
  assert.equal(set.was, 1000);
  assert.equal(set.per_day, 1500);
  assert.equal(await budgetFor(env, bank.id), 1500);
  assert.equal(await budgetFor(env, other.id), MANDATES_PER_DAY, "nobody else's budget moved");

  assert.ok((await createMandate(env, bank, { instruction_hash: H("3"), action_hash: H("4") }, T0 + 4)).id > 0);
  fill("mandates", bank.id, 499, T0 + 5, 6_000_000);
  await refused(createMandate(env, bank, { instruction_hash: H("5"), action_hash: H("6") }, T0 + 6), 429, /mandate budget spent \(1500\/rolling 24h\)/);

  // Outcomes follow the same number.
  fill("mandate_outcomes", bank.id, MANDATES_PER_DAY, T0 + 7, 7_000_000);
  assert.equal((await addOutcome(env, bank, first.id, { outcome_hash: H("9") }, T0 + 8)).mandate, first.id, "the 1001st outcome of the day, inside a budget of 1500");
  // And an account with no budget set stops at the default.
  const theirs = await createMandate(env, other, { instruction_hash: H("7"), action_hash: H("8") }, T0 + 9);
  fill("mandate_outcomes", other.id, MANDATES_PER_DAY, T0 + 10, 8_000_000);
  await refused(addOutcome(env, other, theirs.id, { outcome_hash: H("9") }, T0 + 11), 429, /outcome budget spent \(1000\/rolling 24h\)/);
});

test("the newest row is the budget and the older ones are its history", async () => {
  const { env, db, keeper, bank } = fixture();
  await setMandateBudget(env, keeper, { handle: "bank", per_day: 50_000, reason: "pilot" }, T0);
  await setMandateBudget(env, keeper, { handle: "bank", per_day: 200, reason: "pilot ended, below the default on purpose" }, T0 + 1);
  assert.equal(await budgetFor(env, bank.id), 200, "a budget can be lowered as well as raised");
  const third = await setMandateBudget(env, keeper, { handle: "bank", per_day: 9000, reason: "second pilot" }, T0 + 2);
  assert.equal(third.was, 200);
  assert.equal(await budgetFor(env, bank.id), 9000);
  const rows = db.prepare("SELECT per_day, reason FROM mandate_budgets ORDER BY id").all() as { per_day: number; reason: string }[];
  assert.deepEqual(rows.map((r) => r.per_day), [50_000, 200, 9000], "no row was edited or removed");
});

test("every budget is sealed into the maintainer's chain and listed for anyone", async () => {
  const { env, db, keeper } = fixture();
  const a = await setMandateBudget(env, keeper, { handle: "bank", per_day: 50_000, reason: "records for all of its users" }, T0);
  const b = await setMandateBudget(env, keeper, { handle: "other", per_day: 3000, reason: "a second account" }, T0 + 1);
  // Pinned as a literal, not recomputed through the module.
  assert.equal(a.commit_payload, `1f916.mandate.budget.v1:bank:50000:${T0}:${await sha256Hex("records for all of its users")}`);
  assert.equal(budgetCommitPayload("bank", 50_000, T0, await sha256Hex("records for all of its users")), a.commit_payload);
  assert.equal(a.commit, await sha256Hex(a.commit_payload));
  const seal = db.prepare("SELECT citizen_id, label, hash FROM seals WHERE id = ?").get(a.seal.id) as { citizen_id: number; label: string; hash: string };
  assert.deepEqual({ ...seal }, { citizen_id: MAINTAINER_ID, label: "mandate-budget", hash: a.commit });
  const ev = db.prepare("SELECT kind, citizen_id FROM identity_events WHERE hash = ?").get(a.seal.chained) as { kind: string; citizen_id: number };
  assert.deepEqual({ ...ev }, { kind: "memory.seal", citizen_id: MAINTAINER_ID });

  const list = await listMandateBudgets(env, undefined);
  assert.equal(list.default_per_day, 1000);
  assert.deepEqual(list.budgets.map((r) => [r.id, r.citizen, r.per_day, r.reason, r.set_by]), [
    [b.id, "other", 3000, "a second account", "keeper"],
    [a.id, "bank", 50_000, "records for all of its users", "keeper"],
  ]);
  for (const r of list.budgets) assert.equal(await sha256Hex(r.commit_payload), r.commit, "a reader can rebuild each commit from what is listed");
  assert.deepEqual((await listMandateBudgets(env, b.id)).budgets.map((r) => r.id), [a.id], "before_id pages backwards");
});

test("a batch carries 1 to 25 records", async () => {
  const { env, db, bank } = fixture();
  assert.equal(BATCH_MAX, 25);
  const rec = (i: number) => ({ instruction_hash: i.toString(16).padStart(64, "0"), action_hash: H("b") });
  await refused(createMandateBatch(env, bank, {}, T0), 400, /records is required/);
  await refused(createMandateBatch(env, bank, { records: [] }, T0), 400, /records is required/);
  await refused(createMandateBatch(env, bank, { records: "many" }, T0), 400, /records is required/);
  await refused(createMandateBatch(env, bank, { records: Array.from({ length: 26 }, (_, i) => rec(i)) }, T0), 400, /holds 26, and one request carries at most 25/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandates").get() as { n: number }).n, 0);
  const full = await createMandateBatch(env, bank, { records: Array.from({ length: 25 }, (_, i) => rec(i)) }, T0);
  assert.equal(full.recorded, 25);
  assert.equal(full.refused, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandates").get() as { n: number }).n, 25);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE label = 'mandate'").get() as { n: number }).n, 25, "each is its own seal");
});

test("one refused record does not undo the others", async () => {
  const { env, db, bank } = fixture();
  const r = await createMandateBatch(
    env,
    bank,
    { records: [{ instruction_hash: H("1"), action_hash: H("2") }, { instruction_hash: "not a hash", action_hash: H("2") }, "not an object", { instruction_hash: H("3"), action_hash: H("4"), subject: "user:a" }, { action_hash: H("4") }] },
    T0,
  );
  assert.equal(r.recorded, 2);
  assert.equal(r.refused, 3);
  assert.deepEqual(r.results.map((x) => [x.index, x.recorded, x.status ?? null]), [[0, true, null], [1, false, 400], [2, false, 400], [3, true, null], [4, false, 400]]);
  assert.match(String(r.results[1].error), /64 hex/);
  assert.match(String(r.results[4].error), /instruction is required/);
  assert.equal(r.results[3].subject, "user:a");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandates").get() as { n: number }).n, 2);
});

test("identical records in one batch are each recorded", async () => {
  const { env, db, bank } = fixture();
  const same = { instruction_hash: H("1"), action_hash: H("2") };
  const r = await createMandateBatch(env, bank, { records: [same, same, same] }, T0);
  assert.equal(r.recorded, 3, JSON.stringify(r.results));
  const commits = new Set(r.results.map((x) => x.commit));
  assert.equal(commits.size, 3, "three commits, because each got its own instant");
  assert.deepEqual(r.results.map((x) => x.created_at), [T0, T0 + 1, T0 + 2]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get() as { n: number }).n, 0, "none was mistaken for a re-check of the one before");
});

test("a batch spends the budget record by record", async () => {
  const { env, fill, bank } = fixture();
  fill("mandates", bank.id, MANDATES_PER_DAY - 2, T0, 5_000_000);
  const r = await createMandateBatch(env, bank, { records: Array.from({ length: 5 }, (_, i) => ({ instruction_hash: (i + 1).toString(16).padStart(64, "0"), action_hash: H("b") })) }, T0 + 1);
  assert.equal(r.recorded, 2, "two were left in the day");
  assert.equal(r.refused, 3);
  assert.deepEqual(r.results.map((x) => x.status ?? 201), [201, 201, 429, 429, 429]);
  assert.match(String(r.results[2].error), /mandate budget spent \(1000\/rolling 24h\)/);
});

test("over HTTP: the budget route is the maintainer's, the list is anyone's, and a batch answers 200", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const e = { ...env, RECORDS: { put: async () => {}, get: async () => null } as unknown as KVNamespace } as Env;
  const call = (method: string, path: string, secret?: string, body?: unknown) =>
    worker.fetch(
      new Request(`https://1f916.ai${path}`, { method, headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.12", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      e,
    );
  const register = async (handle: string) => ((await (await call("POST", "/api/register", undefined, { handle, model: "test-model" })).json()) as { secret: string }).secret;
  const first = await register("first-citizen");
  const second = await register("second-citizen");
  // The first citizen registered is citizen 1, the maintainer.
  assert.equal((await call("POST", "/api/mandates/budget", undefined, { handle: "second-citizen", per_day: 5000, reason: "r" })).status, 401);
  assert.equal((await call("POST", "/api/mandates/budget", second, { handle: "second-citizen", per_day: 5000, reason: "r" })).status, 403);
  const set = await call("POST", "/api/mandates/budget", first, { handle: "second-citizen", per_day: 5000, reason: "records for its users" });
  assert.equal(set.status, 201, await set.clone().text());
  const list = await call("GET", "/api/mandates/budgets");
  assert.equal(list.status, 200);
  assert.deepEqual(((await list.json()) as { budgets: { citizen: string; per_day: number }[] }).budgets.map((b) => [b.citizen, b.per_day]), [["second-citizen", 5000]]);
  assert.equal((await call("GET", "/api/mandates/budgets?befor_id=3")).status, 400, "an unknown parameter is refused");

  assert.equal((await call("POST", "/api/mandates/batch", undefined, { records: [] })).status, 401);
  const batch = await call("POST", "/api/mandates/batch", second, { records: [{ instruction_hash: H("1"), action_hash: H("2") }, { instruction_hash: "bad", action_hash: H("2") }] });
  assert.equal(batch.status, 200);
  const b = (await batch.json()) as { recorded: number; refused: number };
  assert.deepEqual([b.recorded, b.refused], [1, 1]);
  assert.equal((await call("POST", "/api/mandates/batch", second, { records: [] })).status, 400);
});
