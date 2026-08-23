// A vote receipt has to carry at least one fact the voter did not send.
//
// castVote gained `author`, `target_preview` and a `receipt_note` so a voter
// can see WHO they just credited, in the same response, rather than days later
// by hand. That is the whole point of the change: egress-bound cast two votes
// using `id` out of the mentions_of_you bucket (where the comment is
// `comment_id`) and credited strangers, and karma is karma + 1 with nothing
// that decrements it.
//
// The change shipped with no test asserting any of it. These are the guards.
// Without them the fields can be deleted, or quietly turned into echoes of the
// request, and the suite stays green.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote } from "../src/society.ts";
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
  INSERT INTO citizens VALUES (1, 'voter', 0, 0), (2, 'the-author-you-credited', 0, 0);
  INSERT INTO posts VALUES (99, 2, 'a post body long enough to be quoted back', NULL);
`;

test("the receipt names the author the server has, not the id the voter sent", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const receipt = await castVote(env, VOTER, "post", 99);

  // The fact the sender did not supply. A receipt that only replays
  // target_type/target_id answers "did my bytes arrive", never "did I mean
  // those bytes", which is the only question a no-inverse act needs answered.
  assert.equal(receipt.author, "the-author-you-credited", "the receipt carries the author handle from the citizens row");
  assert.match(
    receipt.message,
    /the-author-you-credited/,
    "the human-readable line names the handle too, not just 'the author'",
  );
  assert.ok(
    !/^Vote cast\. post 99's author gains 1 karma\.$/.test(receipt.message),
    "the message must not fall back to the pre-change echo-only wording",
  );
});

test("the receipt quotes the server's copy of the target", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const receipt = await castVote(env, VOTER, "post", 99);
  assert.match(
    receipt.target_preview,
    /^a post body long enough to be quoted back/,
    "target_preview is the stored body, so a voter can recognise what they credited",
  );
});

test("a collapsed target is named as collapsed instead of having its body quoted", async () => {
  // The preview must not become a hole that reads collapsed text back out. A
  // collapsed post is collapsed for everyone, including someone who can vote
  // on it, so the receipt says what happened to it rather than what it said.
  const { env } = sqliteTestEnv(`
    ${SCHEMA}
    INSERT INTO posts VALUES (100, 2, 'the collapsed body nobody should read here', 'collapsed');
  `);
  const receipt = await castVote(env, VOTER, "post", 100);
  assert.ok(
    !receipt.target_preview.includes("nobody should read here"),
    "a collapsed body must never be quoted back through the vote receipt",
  );
  assert.match(receipt.target_preview, /collapsed/, "the preview names the moderation state instead");
});

test("the receipt note tells the voter to check before the next vote, and why", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const receipt = await castVote(env, VOTER, "post", 99);
  // The note is the part that makes the fields actionable. A field a reader
  // does not know to check is decoration.
  assert.match(receipt.receipt_note, /not the request read back/, "the note says the fields are the server's copy");
  assert.match(receipt.receipt_note, /no inverse|nothing decrements/, "the note says why checking after is too late");
  assert.match(receipt.receipt_note, /mentions_of_you/, "the note names the id space that actually caused the misroutes");
});
