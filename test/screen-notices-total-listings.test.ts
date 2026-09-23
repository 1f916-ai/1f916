// GET /api/screen-notices serves notices[], notices_withheld, total, truncated.
// total is the VISIBLE count — the positive of the same clause notices_withheld
// negates — so a short list can separate "redacted" from "truncated".
//
// The listing arm of that clause lived on the page SELECT and on
// notices_withheld, but was missing from total's COUNT. A removed-listing
// hygiene notice was therefore served in notices[] while total skipped it:
// notices.length could exceed total, and truncated lied about whether the
// page held every entitled row. Soft-power closes the drift by binding all
// three sites to SCREEN_NOTICE_VISIBLE_SQL.
//
// Killing mutations this file names:
//   1. Drop the listing arm from SCREEN_NOTICE_VISIBLE_SQL → listing-visible
//      cases go red (withheld + this file).
//   2. Inline a listing-less predicate into visibleRead only → source-guard
//      (three ${SCREEN_NOTICE_VISIBLE_SQL} uses) + listing total case go red.
//   3. Restore total = COUNT(*) of the table → truncated conflates redaction.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { screenNotices, SCREEN_NOTICE_VISIBLE_SQL, type Env } from "../src/society.ts";
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

function addNotice(db: Db, targetType: string, targetId: number, book: string, status: string, createdAt = 1) {
  db.exec(
    `INSERT INTO screen_notices (target_type, target_id, citizen_id, book, rule, screen_version, rules_hash, status, created_at)
     VALUES ('${targetType}', ${targetId}, 1, '${book}', 'phone-number', 4, 'abc', '${status}', ${createdAt})`,
  );
}

test("removed listing hygiene notice is counted in total (kills: listing arm missing from visible COUNT)", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (10, 'removed', NULL, NULL)");
  addNotice(db as Db, "listing", 10, "hygiene", "open");

  const r = await screenNotices(env as Env);
  assert.equal(r.notices.length, 1, "removed listing hygiene notice must be visible on the page");
  assert.equal(r.notices_withheld, 0);
  assert.equal(r.total, 1, "total must count the listing arm — same predicate as the page SELECT");
  assert.equal(r.truncated, false);
  assert.ok(r.notices.length <= r.total, "notices.length must never exceed total");
});

test("total + notices_withheld accounts for every row including listing (kills: total undercounts listings)", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // Three withheld (live targets).
  db.exec("INSERT INTO comments (id, mod_state) VALUES (1, NULL)");
  db.exec("INSERT INTO posts (id, mod_state) VALUES (2, NULL)");
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (8, NULL, NULL, NULL)");
  addNotice(db as Db, "comment", 1, "hygiene", "open", 1);
  addNotice(db as Db, "post", 2, "hygiene", "open", 2);
  addNotice(db as Db, "listing", 8, "hygiene", "open", 3);
  // Four visible, one per visibility branch (incl. removed listing).
  db.exec("INSERT INTO comments (id, mod_state) VALUES (3, 'removed')");
  addNotice(db as Db, "comment", 3, "hygiene", "open", 4);
  db.exec("INSERT INTO posts (id, mod_state) VALUES (4, NULL)");
  addNotice(db as Db, "post", 4, "hygiene", "resolved-removed", 5);
  db.exec("INSERT INTO posts (id, mod_state) VALUES (6, NULL)");
  addNotice(db as Db, "post", 6, "reader-safety", "open", 6);
  db.exec("INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (9, 'removed', NULL, NULL)");
  addNotice(db as Db, "listing", 9, "hygiene", "open", 7);

  const res = await screenNotices(env as Env);
  assert.equal(res.notices.length, 4);
  assert.equal(res.notices_withheld, 3);
  assert.equal(res.total, 4, "total is the visible half, listing arm included");
  assert.equal(res.total + res.notices_withheld, 7, "total + withheld must equal the table");
  assert.equal(res.truncated, false);
});

test("capped page of listing-visible rows: truncated true against the listing-aware total", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let id = 20; id <= 24; id++) {
    db.exec(`INSERT INTO listings (id, mod_state, withdrawn_at, withdraw_reason) VALUES (${id}, 'removed', NULL, NULL)`);
    addNotice(db as Db, "listing", id, "hygiene", "open", id);
  }
  const page = await screenNotices(env as Env, 2);
  assert.equal(page.notices.length, 2);
  assert.equal(page.total, 5, "listing-only visible log must still be counted whole");
  assert.equal(page.truncated, true);
});

test("source-guard: page SELECT, notices_withheld, and total all bind SCREEN_NOTICE_VISIBLE_SQL", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../src/society.ts"), "utf8");
  const uses = src.split("${SCREEN_NOTICE_VISIBLE_SQL}").length - 1;
  assert.equal(uses, 3, "list / withheld / total must share the named visibility clause");
  assert.match(SCREEN_NOTICE_VISIBLE_SQL, /target_type = 'listing'/, "listing arm must stay in the shared clause");
  // A bare listing EXISTS still inlined beside the constant would let one site
  // drift again; after the bind, the only listing EXISTS in screenNotices is
  // inside the exported constant.
  const screenNoticesBody = src.slice(src.indexOf("export async function screenNotices"), src.indexOf("// ---------- payload gate"));
  const listingExistsInBody = (screenNoticesBody.match(/target_type = 'listing'/g) || []).length;
  assert.equal(listingExistsInBody, 0, "no inlined listing arm inside screenNotices — only the constant");
});
