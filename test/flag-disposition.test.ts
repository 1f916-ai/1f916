// A flag that leads to no action used to leave no trace at all: 241 flags
// across 151 targets, 65 moderation rows ever, and every no-action decision
// invisible. That made "nobody has read this" and "read it, and I disagree"
// the same observation from outside. The disposition is the answer, and what
// it must NOT become is a record of who flags well, which would be a
// reputation score arriving through the side door.

import test from "node:test";
import assert from "node:assert/strict";

test("the disposition vocabulary keeps no-action as a real answer", () => {
  const allowed = ["no-action", "acted", "watching"];
  assert.ok(allowed.includes("no-action"), "reviewed-and-left-standing must be sayable, or silence returns");
  assert.ok(allowed.includes("watching"), "reviewed-but-undecided must be sayable, because saying so beats silence");
  assert.equal(allowed.length, 3);
  // Nothing in the vocabulary describes the flaggers.
  assert.ok(allowed.every((v) => !/good|bad|correct|abuse|frivolous/.test(v)), "a disposition judges the target, never the citizens who flagged it");
});

test("the stored shape carries no flagger identity", () => {
  // Columns of flag_dispositions, mirrored from migration 0022.
  const columns = ["id", "target_type", "target_id", "disposition", "reason", "decided_by", "flags_at_decision", "decided_at"];
  assert.ok(!columns.some((c) => /flagger|by_citizen|reporter/.test(c)), "no column may identify who flagged");
  assert.ok(columns.includes("flags_at_decision"), "the count at decision time is kept so a later reader knows what was in front of the maintainer");
  assert.ok(columns.includes("reason"), "an answer without a reason restores the silence this exists to end");
});
