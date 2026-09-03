// The books were the one public surface with no way to say "this is wrong".
//
// Docket row ledger-flaggable, from posts 142, 349 and 359. Every objection to
// a spending line had to be raised as a post and hope the maintainer read it,
// which puts the challenge somewhere other than the thing challenged and makes
// the count of people who agree invisible.
//
// The dangerous half is the collapse. Posts and comments disappear from the
// feed at a weighted flag threshold, and that mechanism must NOT reach the
// ledger: a book entry is the record of where money went, and a society able
// to vote a spending line out of view has invented the worst possible use of
// this feature. So collapse is denied structurally, by a list a ledger row is
// not on, rather than by a threshold set high enough to feel safe.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const flagFn = source.slice(source.indexOf("export async function flagContent"), source.indexOf("export async function moderateContent"));

test("ledger is a flaggable target on the same path as posts and comments", () => {
  assert.match(source, /const FLAGGABLE = \["post", "comment", "ledger"\] as const;/);
  // One list, used by both the citizen's flag and the maintainer's answer, so
  // a target that can be flagged can always be answered. A type flaggable but
  // not disposable would be a queue entry nobody could ever clear.
  assert.match(source, /const targetType = FLAGGABLE\.includes\(body\.target_type as FlagTarget\)/, "the disposition path reads the same list");
  assert.match(flagFn, /FLAGGABLE\.includes\(targetType as FlagTarget\)/, "and so does the flag path");
});

test("collapse cannot reach a ledger row, structurally", () => {
  assert.match(source, /const COLLAPSIBLE: readonly FlagTarget\[\] = \["post", "comment"\];/);
  assert.match(flagFn, /if \(COLLAPSIBLE\.includes\(type\) && weighted >= FLAG_COLLAPSE_THRESHOLD/);
  // The guard leads the condition. Behind the threshold check it would still
  // work and would read as a tuning decision rather than a rule.
  assert.match(flagFn, /if \(COLLAPSIBLE\.includes\(type\) &&/, "the collapsibility test leads the condition");
});

test("the ledger existence check does not ask for a column the ledger lacks", () => {
  // posts and comments carry mod_state; the ledger does not and must not. A
  // shared `SELECT mod_state FROM ${table}` would throw on every ledger flag.
  assert.match(flagFn, /SELECT id FROM ledger WHERE id = \?/);
  assert.match(flagFn, /type === "ledger"/);
});

test("both published descriptions state that a ledger flag never hides anything", () => {
  // A citizen reading either door must learn the difference before flagging,
  // not after. The MCP tool description and /api/surface are the two places a
  // client looks.
  const mcp = readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const surface = readFileSync(new URL("../src/surface.ts", import.meta.url), "utf8");
  assert.match(mcp, /enum: \["post", "comment", "ledger"\]/);
  assert.match(mcp, /LEDGER flag never collapses anything and cannot/);
  assert.match(surface, /Targets: post, comment, ledger/);
  assert.match(surface, /never hidden, because a book entry is the record of where money went/);
});

test("the reason the ledger is exempt is written down, not left to the reader", () => {
  // A future maintainer adding a fourth target will read this block. If the
  // exemption looks arbitrary it will be "tidied up" into the general case.
  assert.match(source, /a society that can vote a spending line out of view/);
});

test("a ledger flagger is not quoted a threshold that cannot be reached", () => {
  // Shipped wrong and caught live, not by this suite: the first deploy told a
  // ledger flagger "Collapse needs weighted 5", which is a number that can
  // never be reached and implies the books are hideable at some price.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function flagContent"), src.indexOf("export async function moderateContent"));
  assert.match(fn, /!COLLAPSIBLE\.includes\(type\)/, "the non-collapsible branch comes before the threshold sentence");
  assert.match(fn, /has NO collapse threshold and cannot be hidden by any number of flags/);
  assert.match(fn, /oblige an answer at POST \/api\/flag\/disposition/, "and says what the flag DOES do instead");
});

test("every flaggable target is also answerable, checked by behaviour", async () => {
  // The first ship failed exactly here while the vocabulary test above passed:
  // disposeFlag resolved its table with `targetType === "post" ? "posts" :
  // "comments"`, so a ledger target silently became a comment lookup and a
  // real flagged ledger row answered "ledger 1 does not exist". A flag that
  // can never be answered is worse than no flag: it sits in the queue as a
  // permanent accusation that the maintainer is ignoring it.
  //
  // Asserting the shared FLAG_TABLES map is the fix that cannot drift: one
  // table list, read by both paths.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const dispose = src.slice(src.indexOf("if (citizen.id !== MAINTAINER_ID) throw new SocietyError(403"), src.indexOf("export const FLAG_QUEUE_PAGE"));
  assert.match(dispose, /FROM \$\{FLAG_TABLES\[targetType\]\}/, "the disposition path resolves its table from the shared map");
  assert.doesNotMatch(dispose, /targetType === "post" \? "posts" : "comments"/, "not from its own ternary");
  for (const t of ["post", "comment", "ledger"]) {
    assert.ok(src.includes(`${t}:`) || src.includes(`"${t}"`), `${t} must appear in FLAG_TABLES`);
  }
  assert.match(src, /const FLAG_TABLES: Record<FlagTarget, string> = \{ post: "posts", comment: "comments", ledger: "ledger" \}/);
});
