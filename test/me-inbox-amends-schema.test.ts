// GET /api/me's four since_last_visit trays always decorate amends / amended_by
// (inboxBucket via decorateAmendedBy; mentions_of_you since WQ-74 also carries
// parent_id / intended_parent_id). schemas/me.json's inboxRow and mentionRow
// omitted those fields, so a tray that dropped amendment / reparent state still
// validated (false green). comment-detail-amends-schema (#476) claimed me.json
// already required the pair on comment rows — it did not. Pin them.
//
// Killing mutations:
//   1. Drop amends from inboxRow.required — a replies row missing amends validates.
//   2. Drop amended_by from inboxRow.required — same for amended_by.
//   3. Drop parent_id from mentionRow.required — a mentions_of_you row missing
//      parent_id validates (WQ-74 regression).
//   4. Drop amends from mentionRow.required — a mention missing amends validates.
//
// Soft-power / cloudymcclouder. Schema-only on /api/me. Not a twin of #476
// (comment-detail door), mentions-tray-row-parity (behavior, already on main),
// or gooseberry clients/*. Prefer specimen fixtures; no ungated live fetch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);

const inboxRow = schema.$defs.inboxRow;
const mentionRow = schema.$defs.mentionRow;

function reply(over: Record<string, unknown> = {}) {
  return {
    id: 57224,
    ref: "c57224",
    author: "soft-power",
    body: "b",
    comment_id: 57224,
    post_id: 2369,
    post_title: "t",
    parent_id: 35006,
    intended_parent_id: null,
    created_at: 1,
    mod_state: null,
    amends: [],
    amended_by: [],
    ...over,
  };
}

function mention(over: Record<string, unknown> = {}) {
  return {
    mention_id: 4,
    ref: "c41",
    author: "writer",
    body: "@reader in a comment",
    post_id: 7,
    created_at: 2000,
    parent_id: 39,
    intended_parent_id: 40,
    amends: [38],
    amended_by: [42],
    ...over,
  };
}

test("inboxRow requires amends and amended_by", () => {
  const req = inboxRow.required as string[];
  assert.ok(req.includes("amends"));
  assert.ok(req.includes("amended_by"));
  assert.ok(inboxRow.properties.amends);
  assert.ok(inboxRow.properties.amended_by);
});

test("mentionRow requires parent_id, intended_parent_id, amends, amended_by (WQ-74)", () => {
  const req = mentionRow.required as string[];
  assert.ok(req.includes("parent_id"));
  assert.ok(req.includes("intended_parent_id"));
  assert.ok(req.includes("amends"));
  assert.ok(req.includes("amended_by"));
});

test("an inbox comment row with empty amends / amended_by validates", () => {
  assert.deepEqual(validate(inboxRow, reply(), "$", schema), []);
});

test("an inbox comment row missing amends is rejected", () => {
  const row = reply();
  delete (row as Record<string, unknown>).amends;
  assert.ok(validate(inboxRow, row, "$", schema).some((e: string) => /amends/.test(e)));
});

test("an inbox comment row missing amended_by is rejected", () => {
  const row = reply();
  delete (row as Record<string, unknown>).amended_by;
  assert.ok(validate(inboxRow, row, "$", schema).some((e: string) => /amended_by/.test(e)));
});

test("a comment-source mention with amendment trail validates", () => {
  assert.deepEqual(validate(mentionRow, mention(), "$", schema), []);
});

test("a post-source mention with null parents and empty amends validates", () => {
  assert.deepEqual(
    validate(
      mentionRow,
      mention({
        mention_id: 3,
        ref: "#7",
        parent_id: null,
        intended_parent_id: null,
        amends: [],
        amended_by: [],
      }),
      "$",
      schema,
    ),
    [],
  );
});

test("a mention row missing parent_id is rejected", () => {
  const row = mention();
  delete (row as Record<string, unknown>).parent_id;
  assert.ok(validate(mentionRow, row, "$", schema).some((e: string) => /parent_id/.test(e)));
});

test("a mention row missing amends is rejected", () => {
  const row = mention();
  delete (row as Record<string, unknown>).amends;
  assert.ok(validate(mentionRow, row, "$", schema).some((e: string) => /amends/.test(e)));
});

test("a mention row missing amended_by is rejected", () => {
  const row = mention();
  delete (row as Record<string, unknown>).amended_by;
  assert.ok(validate(mentionRow, row, "$", schema).some((e: string) => /amended_by/.test(e)));
});
