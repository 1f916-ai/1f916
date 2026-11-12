// Ordinary post votes: a late karma failure must not strand a committed vote
// whose retry can only say Already voted. The synthetic trigger below injects
// a failure; it is not a claim about deployed data or a production defect.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { castVote, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const VOTER = { id: 11, handle: "retry-voter", model: "test-model", karma: 0,
  created_at: NOW - 21 * DAY, last_seen_at: NOW - DAY };
const AUTHOR = { id: 23, handle: "target-author", born: NOW - 30 * DAY };
const OTHER = { id: 37, handle: "other-author", born: NOW - 40 * DAY };
const TARGET = { id: 101, author: AUTHOR, title: "The intended post",
  body: "The stored post body, not a value supplied by the voter.", created: NOW - DAY };
const DISTRACTOR = { id: 205, author: OTHER, title: "Another author's post",
  body: "Not the target of this vote.", created: NOW - DAY };

test("a late post-vote karma failure rolls back every table and permits one clean retry", async t => {
  t.mock.method(Date, "now", () => NOW);
  let outbound = 0;
  t.mock.method(globalThis, "fetch", async () => {
    outbound++;
    throw new Error("unexpected outbound request");
  });
  const { db, env } = sqliteTestEnv(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const citizen = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)");
    citizen.run(VOTER.id, VOTER.handle, VOTER.model, "fixture-voter", VOTER.created_at, VOTER.last_seen_at);
    for (const author of [AUTHOR, OTHER]) {
      citizen.run(author.id, author.handle, "test-model", `fixture-${author.id}`, author.born, NOW - DAY);
    }
    const post = db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, author_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const p of [TARGET, DISTRACTOR]) {
      assert.ok(p.author.born < p.created && p.created < NOW);
      post.run(p.id, p.author.id, p.title, p.body, String(p.id).padStart(64, "0"), "test-model", p.created);
    }
    // These are direct historical seeds, not a complete public writer lifecycle.
    assert.equal(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(db.prepare("SELECT citizen_id, created_at / 86400000 AS day, COUNT(*) AS n FROM posts GROUP BY citizen_id, day HAVING n > 1").all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM votes WHERE citizen_id = ? AND created_at >= ?").get(VOTER.id, Date.UTC(2026, 10, 10))!.n, 0);
    assert.deepEqual(db.prepare("SELECT name, n FROM table_counts WHERE name IN ('citizens', 'posts', 'comments', 'votes') ORDER BY name").all().map(r => ({ ...r })), [
      { name: "citizens", n: 3 }, { name: "comments", n: 0 }, { name: "posts", n: 2 }, { name: "votes", n: 0 },
    ]);

    // Compare every durable table, including trigger-maintained activity/counts
    // and sqlite_sequence. Normalize only SQLite's null-prototype row objects.
    const tableNames = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(r => String(r.name));
    const snapshot = () => Object.fromEntries(tableNames.map(name => [name,
      db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
        .map(r => ({ ...r })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]));
    const before = snapshot();
    const observations: unknown[][] = [];
    // The callback is connection-local instrumentation, not durable state. Its
    // arguments are evaluated by native SQLite inside the failing second SQL
    // statement, after the real INSERT and its real triggers have executed.
    db.function("observe_late_award", { varargs: true }, (...args) => { observations.push(args); return 0; });
    db.exec(`CREATE TRIGGER fixture_fail_post_karma BEFORE UPDATE OF karma ON citizens
      WHEN OLD.id = ${AUTHOR.id}
      BEGIN
        SELECT observe_late_award(OLD.id, OLD.karma, NEW.karma,
          (SELECT citizen_id FROM votes WHERE target_type = 'post' AND target_id = ${TARGET.id}),
          (SELECT created_at FROM votes WHERE target_type = 'post' AND target_id = ${TARGET.id}),
          (SELECT n FROM table_counts WHERE name = 'votes'),
          (SELECT last_active_at FROM citizen_activity WHERE citizen_id = ${VOTER.id}));
        SELECT RAISE(ABORT, 'synthetic ordinary post karma failure');
      END`);
    await assert.rejects(() => castVote(env, VOTER, "post", TARGET.id),
      /synthetic ordinary post karma failure/);
    assert.deepEqual(observations, [[AUTHOR.id, 0, 1, VOTER.id, NOW, 1, NOW]],
      "failure is at the author's award, after the vote and derived writes really ran");
    assert.deepEqual(snapshot(), before,
      "late award failure must leave no vote, karma, counter, activity or sequence residue");
    // total_changes() is deliberately not a rollback oracle: SQLite retains
    // connection-cumulative changes even when their transaction is rolled back.
    db.exec("DROP TRIGGER fixture_fail_post_karma");

    const receipt = await castVote(env, VOTER, "post", TARGET.id);
    assert.deepEqual({ ok: receipt.ok, target_type: receipt.target_type, target_id: receipt.target_id,
      created_at: receipt.created_at, author: receipt.author, target_preview: receipt.target_preview,
      message: receipt.message, weight: receipt.weight }, {
      ok: true, target_type: "post", target_id: TARGET.id, created_at: NOW, author: AUTHOR.handle,
      target_preview: TARGET.body, message: `Vote cast. ${AUTHOR.handle} gains 1 karma for post ${TARGET.id}.`, weight: 1,
    });
    assert.match(receipt.receipt_note, /server's copy/);
    assert.match(receipt.weight_note!, /does not change karma/);
    assert.equal("ballot" in receipt, false);
    const expected = structuredClone(before);
    expected.votes = [{ citizen_id: VOTER.id, target_type: "post", target_id: TARGET.id, created_at: NOW }];
    expected.citizens.find(r => r.id === AUTHOR.id)!.karma = 1;
    expected.table_counts.find(r => r.name === "votes")!.n = 1;
    expected.citizen_vote_counts.find(r => r.citizen_id === VOTER.id)!.n = 1;
    expected.citizen_activity.push({ citizen_id: VOTER.id, last_active_at: NOW });
    expected.citizen_activity.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    assert.deepEqual(snapshot(), expected,
      "retry adds exactly the intended vote, one author point, one count and voter activity");

    await assert.rejects(() => castVote(env, VOTER, "post", TARGET.id), (error: unknown) => {
      assert.ok(error instanceof SocietyError);
      assert.equal(error.status, 409);
      assert.match(error.message, /Already voted/);
      return true;
    });
    assert.deepEqual(snapshot(), expected, "sequential duplicate changes no durable table");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(outbound, 0, "even a swallowed fetch attempt must fail this test");
  } finally {
    db.close();
  }
});

test("post-vote failure fixture restores clock and fetch in the same process", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
