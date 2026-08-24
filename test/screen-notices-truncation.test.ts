// A redacted list and a truncated list are the same short list from outside.
//
// notices_withheld (see screen-notices-withheld.test.ts) closed one of those
// two and left the other open. `notices` also carries only the newest `limit`
// rows, and nothing in the response said so, which means a reader who did the
// arithmetic notices.length + notices_withheld, got less than the log, and
// concluded "redaction accounts for the gap" had no field that disagreed with
// them. It does not: the rest of the gap was the page.
//
// `total` is deliberately the VISIBLE count, the exact positive of the clause
// notices_withheld negates, not COUNT(*) of the table. A total that included
// withheld rows would make `truncated` true on a complete page merely because
// something was being held back, which re-conflates the two facts these fields
// exist to separate.
//
// limit/total/truncated are emitted unconditionally, zero and false included,
// for the same reason notices_withheld is: a key present only when it is
// interesting is byte-identical, on the wire, to a deployment that lacks it.

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

// reader-safety rows are visible unconditionally, so they are the cheapest way
// to build a page of rows a reader is entitled to see.
function addVisible(db: Db, id: number) {
  db.exec(`INSERT INTO comments (id, mod_state) VALUES (${id}, NULL)`);
  db.exec(
    `INSERT INTO screen_notices (target_type, target_id, citizen_id, book, rule, screen_version, rules_hash, status, created_at)
     VALUES ('comment', ${id}, 1, 'reader-safety', 'phone-number', 4, 'abc', 'open', ${id})`,
  );
}

// An open hygiene row on a live target is withheld.
function addWithheld(db: Db, id: number) {
  db.exec(`INSERT INTO comments (id, mod_state) VALUES (${id}, NULL)`);
  db.exec(
    `INSERT INTO screen_notices (target_type, target_id, citizen_id, book, rule, screen_version, rules_hash, status, created_at)
     VALUES ('comment', ${id}, 1, 'hygiene', 'phone-number', 4, 'abc', 'open', ${id})`,
  );
}

test("limit, total and truncated are present on an empty log, with their zeros", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const empty = await screenNotices(env as Env);
  assert.ok("limit" in empty, "an absent key and a zero must never be the same payload");
  assert.ok("total" in empty);
  assert.ok("truncated" in empty);
  assert.equal(empty.total, 0);
  assert.equal(empty.truncated, false);
});

test("a page that holds everything visible says truncated false", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let id = 1; id <= 3; id++) addVisible(db as Db, id);
  const all = await screenNotices(env as Env);
  assert.equal(all.notices.length, 3);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, false);
});

test("a capped page says truncated true and names the total it came from", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let id = 1; id <= 5; id++) addVisible(db as Db, id);
  const page = await screenNotices(env as Env, 2);
  assert.equal(page.notices.length, 2, "the page is capped");
  assert.equal(page.limit, 2, "the cap that was applied is stated");
  assert.equal(page.total, 5, "total is the visible log, not the page");
  assert.equal(page.truncated, true);
});

test("total counts what a reader may see, so withholding alone never reads as truncation", async () => {
  // The load-bearing case. Three visible rows all fit on the page, and two
  // hygiene rows are being withheld. `truncated` must stay false: the reader
  // is holding every row they are entitled to. If total were COUNT(*) of the
  // table, this would claim the page was cut short when it was not, and the
  // two facts notices_withheld exists to separate would collapse again.
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let id = 1; id <= 3; id++) addVisible(db as Db, id);
  for (let id = 10; id <= 11; id++) addWithheld(db as Db, id);
  const r = await screenNotices(env as Env);
  assert.equal(r.notices.length, 3);
  assert.equal(r.notices_withheld, 2, "the withheld rows are still disclosed as withheld");
  assert.equal(r.total, 3, "total is the visible half of the same clause, never COUNT(*)");
  assert.equal(r.truncated, false, "a redacted page is not a truncated page");
});

test("truncation and withholding are reported independently when both are happening", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let id = 1; id <= 4; id++) addVisible(db as Db, id);
  for (let id = 10; id <= 11; id++) addWithheld(db as Db, id);
  const r = await screenNotices(env as Env, 2);
  assert.equal(r.notices.length, 2);
  assert.equal(r.truncated, true, "the page was cut");
  assert.equal(r.total, 4, "out of four visible rows");
  assert.equal(r.notices_withheld, 2, "and separately, two are held back");
});

test("the note tells a reader that a short list has two possible causes", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const r = await screenNotices(env as Env);
  assert.match(r.what_this_is, /newest `limit` rows/, "the note states the page is capped");
  assert.match(
    r.what_this_is,
    /notices_withheld alone cannot tell them apart/,
    "and states why the two causes had to be separated",
  );
});
