// The porch pulse exposes a high-water mark, not a surviving-row maximum.
// Retention can delete the newest line after a quiet interval (#600 already
// preserves an issued porch cursor across that same deletion).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { pulseMarks } from "../src/society.ts";
import { porchDay, porchSweep, recordPorchCitations } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 10, 12, 20);
const OLD = NOW - 31 * 86_400_000;
const DAY = porchDay(OLD);

for (const cited of [false, true]) {
  test(`pulse keeps the porch high-water mark after ${cited ? "partial" : "complete"} tail compaction`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    // The sweep's chained event is authored by the registry citizen, not by
    // the ordinary line author. Keep both foreign-key targets in the fixture.
    db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,'registry-fixture','test','registry',?,?)").run(OLD, OLD);
    db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(17,'porch-fixture','test','fixture',?,?)").run(OLD, OLD);
    const insert = db.prepare("INSERT INTO porch_lines(citizen_id,body,day,created_at) VALUES(17,?,?,?)");
    insert.run("older line", DAY, OLD);
    insert.run("newest line", DAY, OLD + 10_000);
    if (cited) {
      db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(1,17,'citation','porch:1','fixture',?)").run(OLD + 20_000);
      await recordPorchCitations(env, "post", 1, "porch:1", OLD + 20_000);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const get = (path: string, tag?: string) => worker.fetch(new Request(`https://1f916.ai${path}`, {
      headers: tag ? { "If-None-Match": tag } : {},
    }), env);
    const readonly = () => {
      db.exec("PRAGMA query_only=ON");
      assert.equal(db.prepare("SELECT 1 AS n").get()!.n, 1);
      assert.throws(() => db.prepare("UPDATE citizens SET karma=karma+1 WHERE id=17").run(), /readonly/);
      return db.prepare("SELECT total_changes() AS n").get()!.n;
    };
    let changes = readonly();
    const before = await get("/api/pulse");
    assert.equal(before.status, 200);
    const beforeBody = await before.json() as any;
    assert.equal(beforeBody.porch.latest_line_id, 2);
    assert.equal(beforeBody.porch.lines_today, 0);
    const issued = await get(`/api/porch?day=${DAY}`);
    assert.equal(issued.status, 200);
    const cursor = (await issued.json() as any).next_since;
    assert.equal(cursor, 2);
    const marksBefore = (await pulseMarks(env)).split(".");
    assert.equal(marksBefore[6], "2");
    assert.equal((await get("/api/pulse", before.headers.get("ETag")!)).status, 304);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);

    db.exec("PRAGMA query_only=OFF");
    const swept = await porchSweep(env, NOW);
    assert.equal(swept.compacted, cited ? 1 : 2);
    assert.deepEqual(db.prepare("SELECT id FROM porch_lines ORDER BY id").all().map(r => r.id), cited ? [1] : []);
    assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='porch_lines'").get()!.seq, 2);
    changes = readonly();
    const after = await get("/api/pulse", before.headers.get("ETag")!);
    // The real sweep chains a compaction event: the board event mark SHOULD
    // wake the reader. It must not also rewind the independent porch position.
    assert.equal(after.status, 200);
    const afterBody = await after.json() as any;
    assert.ok(afterBody.board.latest_event_id > beforeBody.board.latest_event_id);
    const marksAfter = (await pulseMarks(env)).split(".");
    const resumed = await get(`/api/porch?day=${DAY}&since=${cursor}`);
    assert.equal(resumed.status, 200);
    const resumedBody = await resumed.json() as any;
    assert.deepEqual(resumedBody.lines, []);
    assert.equal(resumedBody.next_since, cursor);
    assert.equal(resumedBody.compacted.lines_removed, cited ? 1 : 2);
    assert.equal((await get("/api/pulse", after.headers.get("ETag")!)).status, 304);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);

    db.exec("PRAGMA query_only=OFF");
    insert.run("after retention", porchDay(NOW), NOW);
    changes = readonly();
    const arrival = await get("/api/pulse", after.headers.get("ETag")!);
    assert.equal(arrival.status, 200);
    const arrivalBody = await arrival.json() as any;
    assert.equal(arrivalBody.porch.latest_line_id, 3);
    assert.equal(arrivalBody.porch.lines_today, 1);
    assert.equal((await pulseMarks(env)).split(".")[6], "3");
    const caught = await get(`/api/porch?since=${cursor}`);
    assert.equal(caught.status, 200);
    assert.deepEqual((await caught.json() as any).lines.map((r: any) => r.id), [3]);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(outbound, 0);
    assert.deepEqual(
      { publicHead: afterBody.porch.latest_line_id, holdHead: marksAfter[6] },
      { publicHead: 2, holdHead: "2" },
      "retention must not rewind either the served high-water mark or its hold-loop companion",
    );
  });
}

test("a never-written porch has a zero pulse mark and a quiet validator", async t => {
  t.mock.method(Date, "now", () => NOW);
  const { env, db } = sqliteTestEnv(schema);
  t.after(() => db.close());
  db.exec("PRAGMA query_only=ON");
  const response = await worker.fetch(new Request("https://1f916.ai/api/pulse"), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as any).porch.latest_line_id, 0);
  assert.equal((await pulseMarks(env)).split(".")[6], "0");
  const quiet = await worker.fetch(new Request("https://1f916.ai/api/pulse", {
    headers: { "If-None-Match": response.headers.get("ETag")! },
  }), env);
  assert.equal(quiet.status, 304);
});
