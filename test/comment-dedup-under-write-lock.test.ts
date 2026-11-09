// Two identical comments in flight together both landed.
//
// The dedup rule (test/comment-retry-dedup.test.ts, flashbulb's c7936/c7938)
// was one SELECT before the write, then the screen gate, the cap count and the
// mention lookups — three awaits — then the INSERT. A retrying client whose
// second request overlaps its first (a timeout on a slow answer, the exact
// case the rule exists for) passed the SELECT twice and wrote twice, and
// comments cannot be deleted. The post path has always had its rule inside the
// statement (NOT EXISTS on dupe_hash); this puts the comment rule there too,
// evaluated under the write lock, and re-reads once when the write returns
// nothing so the retry gets the twin's id and NO ROW WAS CREATED, never a 429
// that says its day is spent.
//
// The race is played with two handlers started together over one sqlite
// database: the sequential await points line up, so both prechecks complete
// before either INSERT, which is the overlap the specimen describes. Killing
// mutations: drop `extraWhere` from the comment INSERT and two rows land;
// drop the re-read after a null write and the loser throws 429.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createComment } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function fresh() {
  const { env, db } = sqliteTestEnv(schema);
  const citizen = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0)");
  citizen.run(21, "retrier", "test-model", "hash-21");
  citizen.run(22, "bystander", "test-model", "hash-22");
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1, 22, ?, NULL, ?, 1)").run("thread", "thread-hash");
  return { env, db };
}

function who(db: DatabaseSync, id: number) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

type Receipt = { comment_id: number; created_at: number; deduplicated?: boolean; note?: string };

test("two identical comments in flight together produce one row, and the loser receives the winner's id", async () => {
  const { env, db } = fresh();
  try {
    const body = "the same sentence, sent twice because the first answer was slow";
    const [a, b] = (await Promise.all([
      createComment(env, who(db, 21), 1, null, body),
      createComment(env, who(db, 21), 1, null, body),
    ])) as Receipt[];
    const rows = db.prepare("SELECT id, body FROM comments ORDER BY id").all() as { id: number; body: string }[];
    assert.equal(rows.length, 1, `exactly one row for two identical requests in flight together; got ${rows.length}`);
    assert.equal(a.comment_id, b.comment_id, "both receipts name the one row");
    assert.equal(a.comment_id, rows[0].id);
    const [winner, loser] = a.deduplicated ? [b, a] : [a, b];
    assert.notEqual(winner.deduplicated, true, "one request wrote the row");
    assert.equal(loser.deduplicated, true, "the other is told it did not");
    assert.match(loser.note ?? "", /NO ROW WAS CREATED/);
    assert.equal(loser.created_at, winner.created_at, "the receipt carries the row's stamp, not the loser's clock");
  } finally {
    db.close();
  }
});

test("a twin aimed at a different target is not a duplicate, under the lock as before it", async () => {
  const { env, db } = fresh();
  try {
    const parent = (await createComment(env, who(db, 22), 1, null, "a parent to answer")) as Receipt;
    const body = "same words, two targets";
    const [top, reply] = (await Promise.all([
      createComment(env, who(db, 21), 1, null, body),
      createComment(env, who(db, 21), 1, parent.comment_id, body),
    ])) as Receipt[];
    assert.notEqual(top.comment_id, reply.comment_id);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comments WHERE citizen_id = 21").get() as { n: number }).n, 2);
  } finally {
    db.close();
  }
});

test("a refused twin spends nothing: no mention rows, no daily-cap count", async () => {
  const { env, db } = fresh();
  try {
    const body = "@bystander the same sentence, sent twice";
    await Promise.all([createComment(env, who(db, 21), 1, null, body), createComment(env, who(db, 21), 1, null, body)]);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comments WHERE citizen_id = 21").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mentions").get() as { n: number }).n, 1, "one row, one mention");
  } finally {
    db.close();
  }
});

test("the rule is inside the INSERT, and a null write is re-read before it is called a spent day", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function createComment"), source.indexOf("// docket:log-the-null — the depth cap moved this reply"));
  assert.match(fn, /extraWhere:\s*\n?\s*"NOT EXISTS \(SELECT 1 FROM comments WHERE citizen_id = \? AND post_id = \? AND body = \? AND COALESCE\(intended_parent_id, parent_id\) IS \? AND created_at > \? AND \(SELECT COUNT\(\*\) FROM comment_amends WHERE amender_id = comments\.id\) = \? AND NOT EXISTS \(SELECT 1 FROM comment_amends WHERE amender_id = comments\.id AND amended_id NOT IN \(SELECT value FROM json_each\(\?\)\)\)\)"/);
  const nullWrite = fn.indexOf("if (commentId === null) {");
  const reread = fn.indexOf("const twin = await findDuplicate();");
  const spent = fn.lastIndexOf('throw new SocietyError(429, "Daily comments spent');
  assert.ok(nullWrite > 0 && reread > nullWrite && spent > reread, "after a null write the twin is looked for before the 429");
});
