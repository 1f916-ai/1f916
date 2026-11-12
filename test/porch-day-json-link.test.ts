// A saved day-specific companion must retain the day shown when it was minted.
// It intentionally starts the whole day's JSON page, not the prose cursor slice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const origin = "https://fixture.invalid";
const today = "2026-11-08";
const beforeMidnight = Date.parse("2026-11-08T23:59:59.000Z");
const afterMidnight = Date.parse("2026-11-09T00:00:01.000Z");
const originalNow = Date.now;
const lines = [
  { id: 3, day: "2026-11-07", body: "PAST-DAY-KEPT", at: Date.parse("2026-11-07T12:00:00Z") },
  { id: 11, day: today, body: "TODAY-FIRST-KEPT", at: Date.parse("2026-11-08T12:00:00Z") },
  { id: 19, day: today, body: "TODAY-SECOND-KEPT", at: Date.parse("2026-11-08T12:00:10Z") },
];

for (const accept of ["text/plain", "text/html"]) {
  for (const path of ["/porch", `/porch/${today}`, "/porch/2026-11-07"]) {
    test(`${path}: This day JSON survives UTC midnight (${accept})`, async (t) => {
      let clock = beforeMidnight;
      t.mock.method(Date, "now", () => clock);
      const { env, db } = sqliteTestEnv(schema);
      t.after(() => db.close());
      db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (1,?,?,?,?,?)")
        .run("day-reader", "test", "fixture-only", Date.parse("2026-11-01T00:00:00Z"), beforeMidnight);
      const insert = db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (?,1,?,?,?)");
      for (const line of lines) insert.run(line.id, line.body, line.day, line.at);
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      db.exec("PRAGMA query_only = ON");
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM porch_lines").get() as { n: number }).n, lines.length);
      assert.throws(() => db.prepare("DELETE FROM porch_lines").run(), /readonly/);
      await assert.rejects(env.DB.prepare("DELETE FROM porch_lines").run(), /readonly/);
      const changes = db.prepare("SELECT total_changes() AS n").get();
      const day = path.endsWith("2026-11-07") ? "2026-11-07" : today;
      const expected = lines.filter((line) => line.day === day).map(({ id, body, day }) => ({ id, body, day }));
      const requestUrl = `${origin}${path}?since=000011`;
      const request = new Request(requestUrl, { headers: { Accept: accept } });
      assert.equal(request.headers.get("Authorization"), null);
      assert.equal(request.headers.get("If-None-Match"), null);
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.ok(body.includes(`the porch, ${day}`));
      if (day === today) {
        assert.ok(body.includes("TODAY-SECOND-KEPT"));
        assert.ok(!body.includes("TODAY-FIRST-KEPT"), "the prose honors its cursor");
      }
      const link = body.match(/This day, JSON:\s+(https:\/\/[^\s<]+)/)?.[1];
      assert.ok(link, "follow the renderer's actual labelled companion");
      const read = async (url: string) => {
        const response = await worker.fetch(new Request(url), env);
        assert.equal(response.status, 200);
        return await response.json() as { day: string; lines: { id: number; body: string; day: string }[] };
      };
      const project = (result: Awaited<ReturnType<typeof read>>) => result.lines.map(({ id, body, day }) => ({ id, body, day }));
      const sameDay = await read(link);
      assert.equal(sameDay.day, day);
      assert.deepEqual(project(sameDay), expected, "JSON still begins the whole day, not the resumed prose slice");
      clock = afterMidnight;
      const later = await read(link);
      const pinned = await read(`${origin}/api/porch?day=${day}`);
      assert.equal(pinned.day, day);
      assert.deepEqual(project(pinned), expected);
      const moving = await read(`${origin}/api/porch`);
      assert.equal(moving.day, "2026-11-09", "unqualified API intentionally continues to mean today");
      assert.deepEqual(moving.lines, []);
      const head = await worker.fetch(new Request(requestUrl, { method: "HEAD", headers: { Accept: accept } }), env);
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.deepEqual(db.prepare("SELECT total_changes() AS n").get(), changes);
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM porch_presence").get() as { n: number }).n, 0);
      assert.equal(later.day, day, "the saved This day JSON link must not become tomorrow's room");
      assert.deepEqual(project(later), expected);
    });
  }
}

test("porch companion boundary tests restore the wall clock", () => {
  assert.equal(Date.now, originalNow);
});
