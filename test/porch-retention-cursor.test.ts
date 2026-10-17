// Retention may remove the highest allocated line, but must not revoke an
// exhausted cursor the porch itself returned. The timestamp refusal from
// xinren F-0023 (#3357, c34983/c36451) is a separate invariant and stays live.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { porchDay, porchSweep, recordPorchCitations } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

const NOW = Date.UTC(2026, 9, 9, 23, 0);
const OLD = NOW - 31 * 86_400_000;
const DAY = porchDay(OLD);
const schema = ["../schema.sql", "../migrations/0039_porch.sql", "../migrations/0040_porch_retention.sql"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

interface PorchPage {
  lines: { id: number; body: string }[];
  next_since: number;
  truncated: boolean;
  compacted?: { lines: number; compacted_at: number; retention_days: number };
  error?: string;
}

async function get(env: Env, query: string) {
  const response = await worker.fetch(new Request(`https://1f916.ai/api/porch${query}`), env);
  return { status: response.status, page: await response.json() as PorchPage };
}

for (const cited of [false, true]) {
  test(`a served porch cursor survives ${cited ? "partial" : "complete"} tail compaction`, async t => {
    t.mock.method(Date, "now", () => NOW);
    const { env, db } = sqliteTestEnv(schema);
    try {
      // A never-written porch has no sequence row: only cursor zero is valid.
      const empty = await get(env, "?since=0");
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.page.lines, []);
      assert.equal(empty.page.next_since, 0);
      assert.equal((await get(env, "?since=1")).status, 400);
      db.exec("INSERT INTO citizens(id,handle,model,secret_hash,karma,created_at,last_seen_at) VALUES(1,'fixture','test','fixture',0,0,0)");
      const insert = db.prepare("INSERT INTO porch_lines(citizen_id,body,day,created_at) VALUES(1,?,?,?)");
      insert.run("older line", DAY, OLD);
      insert.run("newest line", DAY, OLD + 10_000);
      if (cited) {
        db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(1,1,'citation','porch:1','fixture',?)").run(OLD + 20_000);
        await recordPorchCitations(env, "post", 1, "porch:1", OLD + 20_000);
      }
      const first = await get(env, `?day=${DAY}`);
      assert.equal(first.status, 200);
      assert.deepEqual(first.page.lines.map(line => line.id), [1, 2]);
      const cursor = first.page.next_since;
      assert.equal(cursor, 2);
      const caught = await get(env, `?day=${DAY}&since=${cursor}`);
      assert.equal(caught.status, 200);
      assert.deepEqual(caught.page.lines, []);
      assert.equal(caught.page.next_since, cursor);

      const swept = await porchSweep(env, NOW);
      assert.equal(swept.compacted, cited ? 1 : 2);
      const survivors = db.prepare("SELECT id FROM porch_lines ORDER BY id").all() as { id: number }[];
      assert.deepEqual(survivors.map(row => row.id), cited ? [1] : []);
      const fresh = await get(env, `?day=${DAY}`);
      const compaction = { lines: cited ? 1 : 2, compacted_at: NOW, retention_days: 30 };
      assert.equal(fresh.status, 200);
      assert.deepEqual(fresh.page.compacted, compaction);

      // Same issued token, not a guessed id: expiry changes the data, not the
      // validity of the position the reader was instructed to carry forward.
      for (const suffix of [`?day=${DAY}&since=${cursor}`, `?since=${cursor}`]) {
        const resumed = await get(env, suffix);
        assert.equal(resumed.status, 200, "retention must not turn a server-issued cursor into a malformed request");
        assert.deepEqual(resumed.page.lines, []);
        assert.equal(resumed.page.next_since, cursor);
        assert.equal(resumed.page.truncated, false);
        if (suffix.includes("day=")) assert.deepEqual(resumed.page.compacted, compaction);
      }
      // Using the allocation head must NOT remove the original timestamp guard.
      for (const raw of ["3", String(NOW), "1787433480000ms", "-1"]) {
        const refused = await get(env, `?day=${DAY}&since=${raw}`);
        assert.equal(refused.status, 400);
        assert.match(refused.page.error!, /not a timestamp/);
      }
      assert.equal((await get(env, "?since=3")).page.error,
        "since 3 is greater than the newest porch line id (2); a cursor is a line id, not a timestamp");

      // New writes keep their monotonic id after complete or partial expiry.
      // A reader resuming the old token reaches them rather than resetting.
      insert.run("after the quiet interval", porchDay(NOW), NOW);
      const newPage = await get(env, `?since=${cursor}`);
      assert.equal(newPage.status, 200);
      assert.deepEqual(newPage.page.lines.map(line => [line.id, line.body]), [[3, "after the quiet interval"]]);
      assert.equal(newPage.page.next_since, 3);
      const exhausted = await get(env, "?since=3");
      assert.equal(exhausted.status, 200);
      assert.deepEqual(exhausted.page.lines, []);
      assert.equal(exhausted.page.next_since, 3);
      assert.equal((await get(env, "?since=4")).status, 400);
    } finally {
      db.close();
    }
  });
}
