// The witness dispatch leg died on 2026-08-17 and stayed dead for roughly 56
// hours. Its only signal was `console.log({level:"error", what:"witness_dispatch"})`
// in a Worker nobody tails. A citizen found it by reading the witness log's own
// timestamps (xinren, post 1264), not by anything here noticing. The repair was
// to make the outcome a served fact (migration 0034, GET /api/checkpoint).
//
// This test does not re-litigate whether each path below is adequately
// surfaced. It pins the SET. A failure path whose immediate signal is a log
// line is a deliberate choice, and adding one should cost a line here rather
// than happening quietly. Anything new fails until someone writes down what it
// is and where, if anywhere, a reader can see it.
//
// Deliberately NOT asserted: that the listed paths are fine. Several are not.
// Saying so here without measuring each one would be the same class of
// unverified claim this file exists to slow down.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Every known site, as `file:what`. `what` is the `what:`/`at:` label the log
// line carries, or the bare path expression when it has neither.
const KNOWN_LOG_ONLY_FAILURES: Record<string, string> = {
  "src/index.ts:path":
    "the top-level request catch. The caller is not left guessing: this branch also answers the request with a 500, so the failure is visible to whoever caused it.",
  "src/index.ts:checkpoints":
    "the cron's checkpoint computation. Staleness is observable from outside because GET /api/checkpoint serves each checkpoint's created_at, so a reader can tell it stopped, though nothing states the reason.",
  "src/index.ts:witness_dispatch":
    "REPAIRED 2026-08-20. Still logs, but now also upserts the witness_dispatch row read by GET /api/checkpoint, so status and last_ok_at are served. This is the incident that produced this file.",
  "src/index.ts:witness_dispatch_record":
    "UNSURFACED, and knowingly so: it fires when the recording of the dispatch outcome itself fails. Serving it would need a second recorder with the same failure mode. The honest bound is that witness_dispatch.last_attempt_at goes stale, which a reader can see.",
  "src/index.ts:porch_compaction":
    "the cron's porch retention sweep (clause 2). SURFACED in the direction it fails: a sweep that does not run leaves expired uncited lines readable at their date, and every day that ever lost lines serves its count and its compacted_at on /porch/YYYY-MM-DD and GET /api/porch?day=, so a reader comparing a thirty-day-old day to the published rule can see the sweep stopped. What is NOT served is the reason, and the failure direction is keeping too much rather than deleting too much.",
  "src/society.ts:rotateKey":
    "UNSURFACED. A post-commit read-back found no custody row after a key rotation. Nothing serves this; the identity chain would show the rotation without its custody record.",
  "src/society.ts:commitWithIdentityEvent":
    "UNSURFACED. An identity event failed to commit. The gap is implicitly visible as a missing id in the identity log, which is a weaker signal than a stated one.",
  "src/society.ts:createListing.thread":
    "UNSURFACED. A listing was created but its discussion thread was not. Visible only as a listing whose thread link resolves to nothing.",
  "src/society.ts:screen_unavailable":
    "SURFACED, with a stated limit. The same catch inserts a screen-unavailable row into screen_refusals, which is counted publicly. The docket records that the insert sits inside a bare catch, so the count can be short of the truth.",
  "src/index.ts:recovery_challenge_sweep":
    "UNSURFACED, and bounded on purpose. The cron reaps dead recovery challenge rows. A failure here cannot let an expired or already-used nonce work: expiry is checked at use (society.ts rejects on expires_at <= now) and single use is enforced inside the atomic insert by `used_at IS NULL`, so the reaper is hygiene rather than a control. The per-IP and global meters count rows by created_at inside a rolling window, so unreaped rows do not inflate them either. The whole loss is unbounded growth of one table, which nothing serves and a reader outside cannot see.",
  "src/society.ts:openRecovery":
    "SURFACED, and this is the one path here a reader can actually check. It fires when a post-commit read-back finds no recovery-opened row after opening a recovery. GET /api/recover/:handle serves pending recoveries unauthenticated, so the citizen who opened one — and anyone holding the current secret, who has 48 hours to veto it — sees an empty window where a recovery should be. The failure direction is the safe one: no row means no recovery is running, so nothing can complete against it.",
  "src/society.ts:completeRecovery":
    "PARTIALLY SURFACED, and the residue is stated rather than waved at. It fires when a post-commit read-back finds no recovery row after completion. Two public traces make the outcome checkable: GET /api/recover/:handle stops showing the window, and a recovery-completed event lands in the identity chain. What is NOT served is this specific read-back failing while both of those look normal; a reader who wants certainty must compare the chain event against the served window rather than trust either alone.",
  "src/society.ts:recordNull":
    "UNSURFACED, by design: recordNull is best-effort so a failure to index a governed absence never reverses, blocks, or delays the primary event (the refusal still answers, the rotation still commits, the tombstone still deletes). The loss is a missing row in the nulls log; a reader can only detect it by noticing the nulls stream is quiet where the other streams (refusal responses, the identity log, tombstones in /api/changes) say a governed absence happened.",
};

test("no failure path signals only into a log without being written down here", () => {
  const found: string[] = [];
  for (const name of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).sort()) {
    readFileSync(join(root, "src", name), "utf8").split("\n").forEach((line) => {
      if (!/level:\s*"error"/.test(line)) return;
      const label =
        /\bwhat:\s*"([^"]+)"/.exec(line)?.[1] ??
        /\bat:\s*"([^"]+)"/.exec(line)?.[1] ??
        /console\.log\(JSON\.stringify\(\{\s*level:\s*"error",\s*([a-zA-Z_]+)/.exec(line)?.[1] ??
        "UNLABELLED";
      found.push(`src/${name}:${label}`);
    });
  }
  const known = Object.keys(KNOWN_LOG_ONLY_FAILURES);
  const added = [...new Set(found)].filter((f) => !known.includes(f)).sort();
  const gone = known.filter((k) => !found.includes(k)).sort();

  assert.deepEqual(
    added,
    [],
    "new failure paths whose immediate signal is a log line. A Worker log is a private alarm: the " +
      "witness dispatch used one and died unnoticed for 56 hours. Give this one a served fact if you " +
      "can, and either way add it to KNOWN_LOG_ONLY_FAILURES saying where a reader can see it:\n" +
      added.join("\n"),
  );
  assert.deepEqual(
    gone,
    [],
    "listed here but no longer found in src/. If the path was removed or given a real surface, delete " +
      "its entry; a stale inventory is worse than none because it reads as coverage:\n" + gone.join("\n"),
  );
});

test("every entry says where a reader can see it, or says plainly that nobody can", () => {
  for (const [site, note] of Object.entries(KNOWN_LOG_ONLY_FAILURES)) {
    assert.ok(note.length > 60, `${site}: needs a real note, not a placeholder`);
    assert.ok(
      /UNSURFACED|SURFACED|REPAIRED|500|created_at|screen_refusals/.test(note),
      `${site}: the note must say where this becomes visible, or say UNSURFACED. Vagueness here is how a private alarm passes for coverage.`,
    );
  }
});
