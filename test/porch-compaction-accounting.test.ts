// Compaction receipts count the rows this sweep actually deletes, not the
// earlier candidate census. Model allowed between-request interleavings using
// real SQLite results/writes; this is not a deployed D1 concurrency benchmark.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { porchDay, porchSweep, recordPorchCitations } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

const NOW = Date.UTC(2026, 10, 7, 1);
const DAY_MS = 86_400_000;
const schema = ["../schema.sql", "../migrations/0039_porch.sql", "../migrations/0040_porch_retention.sql"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;

function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.exec("INSERT INTO citizens(id,handle,model,secret_hash,karma,created_at,last_seen_at) VALUES(81,'sweep-fixture','test','fixture',0,0,0)");
  function line(id: number, age: number) {
    const at = NOW - age * DAY_MS;
    const day = porchDay(at);
    f.db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES(?,81,?,?,?)")
      .run(id, `line ${id}`, day, at);
    return day;
  }
  return { ...f, line };
}

// Deliver one genuine candidate SELECT only after the competing operation
// commits. Mark interception before invoking it, so nested sweeps cannot recur.
function afterCandidateRead(env: Env, action: () => Promise<void>) {
  let calls = 0;
  const wrapped = {
    ...env,
    DB: {
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (!sql.includes("SELECT l.day AS day, COUNT(*) AS n FROM porch_lines l")) return statement;
        const all = statement.all.bind(statement);
        statement.all = async (...args: unknown[]) => {
          const rows = await all(...args as []);
          calls++;
          assert.equal(calls, 1, "the gate must run once on the actual candidate read");
          assert.ok(rows.results.length > 0, "the fixture must reach a nonempty sweep");
          await action();
          return rows;
        };
        return statement;
      },
      batch: env.DB.batch.bind(env.DB),
    },
  } as unknown as Env;
  return { env: wrapped, count: () => calls };
}

async function archive(env: Env, day: string, expectedIds: number[], compacted?: { lines: number; compacted_at: number }) {
  const response = await worker.fetch(new Request(`https://1f916.ai/api/porch?day=${day}`), env);
  assert.equal(response.status, 200);
  const page = await response.json() as { lines: { id: number }[]; compacted?: object; truncated: boolean };
  assert.deepEqual(page.lines.map(row => row.id), expectedIds);
  assert.equal(page.truncated, false);
  assert.deepEqual(page.compacted, compacted && { ...compacted, retention_days: 30 });
  const text = await worker.fetch(new Request(`https://1f916.ai/porch/${day}`), env);
  assert.equal(text.status, 200);
  const body = await text.text();
  if (compacted) assert.match(body, new RegExp(`${compacted.lines} lines? from this day (?:was|were) not cited`));
  else assert.doesNotMatch(body, /from this day (?:was|were) not cited/);
}

for (const preexisting of [false, true]) {
  test(`overlapping porch sweeps do not count or restamp another sweep's deletions (prior receipt=${preexisting})`, async t => {
    t.mock.method(Date, "now", () => NOW + 1000);
    t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected outbound request"); });
    const { env, db, line } = fixture();
    try {
      const oldest = line(11, 45);
      line(29, 45);
      const other = line(47, 31);
      const boundary = line(63, 30);
      const young = line(89, 29);
      if (preexisting) db.prepare("INSERT INTO porch_compactions(day,lines,compacted_at) VALUES(?,7,?)").run(oldest, NOW - DAY_MS);
      const gate = afterCandidateRead(env, async () => {
        const winner = await porchSweep(env, NOW + 1000);
        assert.deepEqual(winner.days, [{ day: oldest, lines: 2 }, { day: other, lines: 1 }]);
        assert.equal(winner.compacted, 3);
      });
      const loser = await porchSweep(gate.env, NOW);
      assert.equal(gate.count(), 1);
      await archive(env, oldest, [], { lines: preexisting ? 9 : 2, compacted_at: NOW + 1000 });
      assert.equal(loser.compacted, 0, "a stale candidate list earns no deletions");
      assert.deepEqual(loser.days, []);
      assert.deepEqual(db.prepare("SELECT day,lines,compacted_at FROM porch_compactions ORDER BY day").all().map(r => ({ ...r })), [
        { day: oldest, lines: preexisting ? 9 : 2, compacted_at: NOW + 1000 },
        { day: other, lines: 1, compacted_at: NOW + 1000 },
      ]);
      await archive(env, oldest, [], { lines: preexisting ? 9 : 2, compacted_at: NOW + 1000 });
      await archive(env, other, [], { lines: 1, compacted_at: NOW + 1000 });
      await archive(env, boundary, [63]);
      await archive(env, young, [89]);
      assert.deepEqual(await porchSweep(env, NOW + 2000), { cutoff: porchDay(NOW - 30 * DAY_MS), compacted: 0, days: [] });
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { db.close(); }
  });
}

for (const allCited of [false, true]) {
  test(`a citation recorded after the candidate read changes the actual compaction receipt (all cited=${allCited})`, async t => {
    t.mock.method(Date, "now", () => NOW);
    t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected outbound request"); });
    const { env, db, line } = fixture();
    try {
      const day = line(101, 40);
      line(119, 40);
      // The citation source is an ordinary live post. Direct fixture seeding
      // and the real citation recorder are not a complete writer lifecycle.
      const body = allCited ? "carried porch:101 and porch:119" : "carried porch:101";
      db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(211,81,'carried lines',?,'citation-fixture',?)").run(body, NOW);
      const gate = afterCandidateRead(env, async () => {
        assert.deepEqual(await recordPorchCitations(env, "post", 211, body, NOW), allCited ? [101, 119] : [101]);
      });
      const result = await porchSweep(gate.env, NOW);
      assert.equal(gate.count(), 1);
      const count = allCited ? 0 : 1;
      await archive(env, day, allCited ? [101, 119] : [101], allCited ? undefined : { lines: 1, compacted_at: NOW });
      assert.equal(result.compacted, count, "the receipt must follow the rechecked live-citation predicate");
      assert.deepEqual(result.days, allCited ? [] : [{ day, lines: 1 }]);
      await archive(env, day, allCited ? [101, 119] : [101], allCited ? undefined : { lines: 1, compacted_at: NOW });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM porch_compactions").get()!.n, allCited ? 0 : 1,
        "a day that lost nothing must not acquire a zero compaction row");
    } finally { db.close(); }
  });
}

test("a failed compaction receipt rolls back its deletion; a later retry counts it once", async t => {
  t.mock.method(Date, "now", () => NOW);
  t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected outbound request"); });
  const { env, db, line } = fixture();
  try {
    const day = line(301, 50);
    line(319, 50);
    db.exec("CREATE TRIGGER fixture_refuse_receipt BEFORE INSERT ON porch_compactions BEGIN SELECT RAISE(ABORT, 'fixture receipt unavailable'); END");
    await assert.rejects(() => porchSweep(env, NOW), /fixture receipt unavailable/);
    await archive(env, day, [301, 319]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM porch_compactions").get()!.n, 0);
    db.exec("DROP TRIGGER fixture_refuse_receipt");
    assert.deepEqual((await porchSweep(env, NOW)).days, [{ day, lines: 2 }]);
    await archive(env, day, [], { lines: 2, compacted_at: NOW });
    assert.equal((await porchSweep(env, NOW + 1000)).compacted, 0);
    await archive(env, day, [], { lines: 2, compacted_at: NOW });
  } finally { db.close(); }
});

test("compaction accounting fixtures restore contextual clock and network mocks", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
