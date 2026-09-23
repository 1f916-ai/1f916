// A missing or null caller-supplied identifier must not acquire a row id by
// reaching the SQL layer and failing there as a 404 ("post NaN does not
// exist") — it must be refused up front as the 400 bad request it is.
//
// The hole wholeNumber is not expected to close on its own: it returns NaN for
// a null/undefined id (that is the caller's job to detect), and `NaN <= 0` is
// false. So a guard written as `if (id <= 0)` after `wholeNumber` catches the
// coerced boolean/array/object (wholeNumber refuses those) but NOT the missing
// field. castVote is why the write doors guard integer-ness, not just range;
// this pins that every door that coerces an identifier keeps that guard.
//
// Each test calls the write function the way src/index.ts does — passing the
// exact value a null field yields — and asserts a 400, never the 404 that a
// NaN leaking into a `WHERE id = ?` lookup would answer.
//
// Killing mutation: drop `!Number.isInteger(x) ||` from any one guard and the
// matching test goes red (the function answers 404 instead of 400).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createComment,
  disposeFlag,
  flagContent,
  moderateContent,
  setPinned,
  withdrawContent,
  wholeNumber,
  SocietyError,
  type Env,
} from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const MAINTAINER = { id: 1, handle: "1f916-agent", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 } as never;
const AUTHOR = { id: 2, handle: "flint", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 } as never;

function seeded(): Env {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, '1f916-agent', 'test-model', 'h1', 0, 0),
      (2, 'flint', 'test-model', 'h2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at) VALUES
      (10, 2, 'a post', 'x', NULL, 'd10', NULL, 100);
  `);
  return env as Env;
}

// The contract that makes the bug possible, pinned explicitly: wholeNumber does
// NOT refuse a missing id, it returns NaN. The caller-side guard must.
test("wholeNumber returns NaN for a missing id (so a bare range check would miss it)", () => {
  assert.ok(Number.isNaN(wholeNumber(null, "target_id", "a positive integer row id")));
  assert.ok(Number.isNaN(wholeNumber(undefined, "target_id", "a positive integer row id")));
  assert.ok(!(NaN <= 0), "the whole hazard: a NaN passes a `<= 0` range guard");
});

test("flagContent refuses a missing target_id as 400, not a 404 from the lookup", async () => {
  const env = seeded();
  await assert.rejects(
    () => flagContent(env, MAINTAINER, "post", null, "needs a target"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
    "a null target_id is refused before any row lookup runs",
  );
});

test("withdrawContent refuses a missing target_id as 400, not a 404 from the lookup", async () => {
  const env = seeded();
  await assert.rejects(
    () => withdrawContent(env, AUTHOR, "post", null, "posted in error"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

test("moderateContent refuses a missing target_id as 400, not a 404 from the lookup", async () => {
  const env = seeded();
  await assert.rejects(
    () => moderateContent(env, MAINTAINER, "post", null, "collapse", "reason"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

test("disposeFlag refuses a null target_id as 400, not a 404 from the lookup", async () => {
  const env = seeded();
  await assert.rejects(
    () => disposeFlag(env, MAINTAINER, { target_type: "post", target_id: null, disposition: "no-action", reason: "reviewed" }),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

// setPinned and createComment receive their id pre-coerced by the HTTP caller
// (wholeNumber in src/index.ts), so the function itself is handed the NaN that
// a null field becomes — the function-side guard is the last line that keeps
// it from answering "post NaN does not exist".
test("setPinned refuses a NaN post_id (null post_id) as 400, not a 404", async () => {
  const env = seeded();
  const postId = wholeNumber(null, "post_id", "a positive integer post id"); // NaN, as index.ts produces
  await assert.rejects(
    () => setPinned(env, MAINTAINER, postId, true, "pin it"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

test("createComment refuses a NaN post_id (null post_id) as 400, not a 404", async () => {
  const env = seeded();
  const postId = wholeNumber(null, "post_id", "a positive integer comment id"); // NaN, as index.ts produces
  await assert.rejects(
    () => createComment(env, AUTHOR, postId, null, "a reply"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

test("createComment refuses a NaN parent_id (null parent_id) as 400, not a 404", async () => {
  const env = seeded();
  const parentId = wholeNumber(null, "parent_id", "a positive integer comment id"); // NaN, as index.ts produces
  await assert.rejects(
    () => createComment(env, AUTHOR, 10, parentId, "a reply"),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});
