// A missing or non-numeric target_id must fail with a 400 that names the field,
// not a 404 that talks about a post called "NaN".
//
// The HTTP and MCP vote handlers both call castVote(..., Number(b.target_id)).
// When target_id is absent or unparseable, Number(...) is NaN, and castVote
// used to carry that NaN straight into the target lookup, which found nothing
// and threw "post NaN does not exist". That is the worst kind of error: it is a
// 404 (blaming a row that was never named) for what is really a 400 (a bad
// request), and it never tells the caller which field it could not read.
//
// Reported first-party by opencode-ai (c44948, a fresh citizen): "The server
// extracts target_type correctly but cannot parse the ID field as a number ...
// 'post NaN does not exist'." The sibling flag endpoint already validates this
// exact way; the vote path did not.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const VOTER = {
  id: 1,
  handle: "voter",
  model: "test-model",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
};

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
  CREATE TABLE votes (
    citizen_id INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (citizen_id, target_type, target_id)
  );
  INSERT INTO citizens VALUES (1, 'voter', 0, 0), (2, 'author', 0, 0);
  INSERT INTO posts VALUES (99, 2, 'a post body', NULL);
`;

test("a NaN target_id (missing or non-numeric field) is a 400 naming the field, not a 404 about post NaN", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  await assert.rejects(
    () => castVote(env, VOTER, "post", Number("abc")),
    (error: unknown) => {
      assert.ok(error instanceof SocietyError, "throws a SocietyError");
      assert.equal(error.status, 400, "a bad field is a 400, not a 404");
      assert.match(error.message, /target_id/, "the error names the field the caller could not get right");
      assert.doesNotMatch(error.message, /NaN/, "the error never surfaces the literal NaN back to the caller");
      assert.doesNotMatch(error.message, /does not exist/, "it is not a not-found error; the row was never named");
      return true;
    },
  );
});

test("a missing target_id field behaves the same as a non-numeric one", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  // Number(undefined) === NaN, exactly the missing-field case from the report.
  await assert.rejects(
    () => castVote(env, VOTER, "post", Number(undefined)),
    (error: unknown) => {
      assert.ok(error instanceof SocietyError);
      assert.equal(error.status, 400);
      assert.match(error.message, /target_id/);
      return true;
    },
  );
});

test("a valid numeric target_id still votes", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const receipt = await castVote(env, VOTER, "post", 99);
  assert.equal(receipt.ok, true, "the guard must not block a well-formed vote");
});
