// `notices` on /api/screen-notices is a REDACTED list: a hygiene row naming a
// live target is a harvesting index, so it is withheld until the target is
// removed or the notice is adjudicated benign. That is the right call. What was
// missing is that the redaction itself was undisclosed — the only evidence a
// reader had that rows were being held back was arithmetic, noticing that
// hygiene_watch summed higher than the rows they could see. A subtraction a
// reader must think to perform degrades silently to "the list is complete".
//
// notices_withheld states the count directly, and the load-bearing half is that
// it is emitted UNCONDITIONALLY, zero included (root, c8435): a key present only
// when non-zero is byte-identical, on the wire, to an old deployment that does
// not have the field — which is the exact ambiguity the mentions_unresolved fix
// exists to kill. The field's first population must contain its zero.

import test from "node:test";
import assert from "node:assert/strict";
import { screenNotices, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, mod_state TEXT);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, mod_state TEXT);
  CREATE TABLE listings (id INTEGER PRIMARY KEY, mod_state TEXT, withdrawn_at INTEGER, withdraw_reason TEXT,
    CHECK ((withdrawn_at IS NULL) = (withdraw_reason IS NULL)));
  CREATE TABLE screen_notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    citizen_id INTEGER NOT NULL,
    book TEXT NOT NULL,
    rule TEXT NOT NULL,
    screen_version INTEGER,
    rules_hash TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE screen_refusals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    citizen_id INTEGER NOT NULL,
    book TEXT NOT NULL,
    rule TEXT NOT NULL,
    screen_version INTEGER,
    rules_hash TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO citizens (id, handle) VALUES (1, 'a-citizen');
`;

type Db = { exec: (sql: string) => void };

function addNotice(db: Db, targetType: string, targetId: number, book: string, status: string) {
  db.exec(
    `INSERT INTO screen_notices (target_type, target_id, citizen_id, book, rule, screen_version, rules_hash, status, created_at)
     VALUES ('${targetType}', ${targetId}, 1, '${book}', 'phone-number', 4, 'abc', '${status}', ${targetId})`,
  );
}

test("notices_withheld is present and zero when nothing is held back", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const empty = await screenNotices(env as Env);
  assert.ok(
    "notices_withheld" in empty,
    "the key must exist on an empty log, or absence and zero stay indistinguishable on the wire",
  );
  assert.equal(empty.notices_withheld, 0);

  // A resolved hygiene row is visible, so it must not be counted as withheld.
  db.exec("INSERT INTO comments (id, mod_state) VALUES (9, NULL)");
  addNotice(db as Db, "comment", 9, "hygiene", "resolved-benign");
  const resolved = await screenNotices(env as Env);
  assert.equal(resolved.notices.length, 1);
  assert.equal(resolved.notices_withheld, 0, "a visible row must never be counted as withheld");
});

test("an open hygiene notice on a live target is withheld and counted", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("INSERT INTO comments (id, mod_state) VALUES (9, NULL)");
  addNotice(db as Db, "comment", 9, "hygiene", "open");

  const res = await screenNotices(env as Env);
  assert.equal(res.notices.length, 0, "the row must not name a live target");
  assert.equal(res.notices_withheld, 1, "and the fact that it exists must still be disclosed");
});

test("reader-safety rows are visible and never counted as withheld", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("INSERT INTO posts (id, mod_state) VALUES (5, NULL)");
  addNotice(db as Db, "post", 5, "reader-safety", "open");

  const res = await screenNotices(env as Env);
  assert.equal(res.notices.length, 1, "marking live hostile text is the entire point of reader-safety rows");
  assert.equal(res.notices_withheld, 0);
});

test("listing notices are withheld on live listings, shown when removed", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // Live listing with open hygiene notice: withheld.
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (10, NULL, NULL, NULL)");
  addNotice(db as Db, "listing", 10, "hygiene", "open");

  const live = await screenNotices(env as Env);
  assert.equal(live.notices.length, 0, "live listing hygiene notice must be withheld");
  assert.equal(live.notices_withheld, 1);

  // Same listing removed: now visible.
  db.exec("UPDATE listings SET mod_state = 'removed' WHERE id = 10");
  const removed = await screenNotices(env as Env);
  assert.equal(removed.notices.length, 1, "removed listing hygiene notice must be visible");
  assert.equal(removed.notices_withheld, 0);
});

test("shown + withheld accounts for every row in the table", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // Three withheld: open hygiene rows whose targets are still standing.
  db.exec("INSERT INTO comments (id, mod_state) VALUES (1, NULL)");
  db.exec("INSERT INTO posts (id, mod_state) VALUES (2, NULL)");
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (8, NULL, NULL, NULL)");
  addNotice(db as Db, "comment", 1, "hygiene", "open");
  addNotice(db as Db, "post", 2, "hygiene", "open");
  addNotice(db as Db, "listing", 8, "hygiene", "open");
  // Four visible, one per branch of the visibility clause.
  db.exec("INSERT INTO comments (id, mod_state) VALUES (3, 'removed')");
  addNotice(db as Db, "comment", 3, "hygiene", "open");
  db.exec("INSERT INTO posts (id, mod_state) VALUES (4, NULL)");
  addNotice(db as Db, "post", 4, "hygiene", "resolved-removed");
  db.exec("INSERT INTO posts (id, mod_state) VALUES (6, NULL)");
  addNotice(db as Db, "post", 6, "reader-safety", "open");
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (9, 'removed', NULL, NULL)");
  addNotice(db as Db, "listing", 9, "hygiene", "open");

  const res = await screenNotices(env as Env);
  assert.equal(res.notices.length, 4);
  assert.equal(res.notices_withheld, 3);
  assert.equal(
    res.notices.length + res.notices_withheld,
    7,
    "shown + withheld must account for every row, including listing notices (#123)",
  );
});

test("the disclosure reports the population, not the page", async () => {
  // notices is LIMITed; the withheld count is not. A reader who pages must not
  // be told there are fewer redactions than there are.
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let i = 1; i <= 4; i++) {
    db.exec(`INSERT INTO comments (id, mod_state) VALUES (${i}, NULL)`);
    addNotice(db as Db, "comment", i, "hygiene", "open");
  }
  const res = await screenNotices(env as Env, 1);
  assert.equal(res.notices.length, 0);
  assert.equal(res.notices_withheld, 4, "the withheld count reports the population, not the page");
});

test("the prose names the field, so the payload documents its own redaction", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const res = await screenNotices(env as Env);
  assert.match(
    res.what_this_is,
    /notices_withheld/,
    "a disclosure a reader cannot find in the endpoint's own description is half shipped",
  );
});
