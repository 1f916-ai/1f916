// GET /api/anchors now HAS a pass that upgrades pending OpenTimestamps rows
// (issue #517: it never did, so all OTS rows stayed pending forever, reported
// by Wotuu). The served prose from the first #517 fix — "stays pending here
// permanently / never flips / confirmed_at stays null" — described that absent
// pass truthfully, and this rewrite pins the NEW truth:
//   - what_an_anchor_proves must describe the upgrade pass, the flip to
//     `confirmed` on a Bitcoin attestation, and the stored completed proof;
//   - it must NOT claim rows stay pending permanently or never flip;
//   - how_to_verify.ots must name both paths: this server's pass, and the
//     reader's own `ots upgrade` on the served file.
//
// KILLING MUTATION: restore the old "stays `pending` here permanently" wording
// in src/anchors.ts -> the assertions go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { listAnchors } from "../src/anchors.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at)
           VALUES (10, 'identity_events', 5, '${"a".repeat(64)}', 'sigA', 1790000000000);`);
  // One pending OTS row, as anchorCheckpoints inserts it: incomplete proof,
  // status pending, confirmed_at null. The upgrade pass will change it; this
  // test reads the prose with the row still pending, as a fresh reader would.
  db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
           VALUES (10, 'ots', 'https://alice.btc.calendar.opentimestamps.org', 'cHJvb2Y=', 'pending', NULL, 1790000000000, NULL);`);
  return { env, db };
}

test("GET /api/anchors prose describes the OTS upgrade pass, not permanent pending (issue #517)", async () => {
  const { env } = fixture();
  const body = await listAnchors(env, undefined) as { what_an_anchor_proves: string; how_to_verify: { ots: string } };
  const proves = body.what_an_anchor_proves;

  // The old permanent-pending claim must be gone: the pass exists now.
  assert.doesNotMatch(
    proves,
    /stays `pending` here permanently/,
    "the prose must not claim OTS rows stay pending forever",
  );
  assert.doesNotMatch(
    proves,
    /never flips/,
    "the prose must not claim the OTS status never flips",
  );
  assert.doesNotMatch(
    proves,
    /has no pass that upgrades it/,
    "the prose must not deny the upgrade pass that now exists",
  );

  // `pending` is this server's label, not the chain's state: live row 1 was in
  // Bitcoin block 968505 six minutes after it was created and read `pending`
  // for 29 days. The prose must not equate the two, nor promise the flip comes
  // within hours of submission; it comes on the first pass that asks after the
  // calendar's transaction is mined.
  assert.doesNotMatch(proves, /'submitted, not yet in a block'/, "pending must not be glossed as 'not yet in a block'");
  assert.doesNotMatch(proves, /upgrade — usually within a few hours of submission/, "the flip is not promised within hours of submission");
  assert.match(proves, /may already be in a Bitcoin block/, "the reader is told a pending row may already be anchored");

  // The new truth must be stated: a pass asks the calendar, a Bitcoin
  // attestation flips the row, and the completed proof is stored here.
  assert.match(proves, /asks the row's calendar for the upgrade/, "must describe the upgrade pass");
  assert.match(proves, /flips to `confirmed`/, "must state the row flips to confirmed");
  assert.match(proves, /Bitcoin attestation/, "must name the Bitcoin attestation as the trigger");
  assert.match(proves, /full proof is kept here/, "must state the completed proof is stored server-side");
  // The reader's own completion path stays documented for rows not yet upgraded.
  assert.match(proves, /ots upgrade/, "must still point the reader to ots upgrade");

  // how_to_verify.ots carries the same truth, both paths named.
  const ots = body.how_to_verify.ots;
  assert.doesNotMatch(ots, /never upgrades it/, "how_to_verify.ots must not deny the upgrade pass");
  assert.match(ots, /asks the calendar for the upgrade on later passes/, "must describe this server's pass");
  assert.match(ots, /ots upgrade/, "must still name ots upgrade as the reader's own path");
  assert.match(ots, /`confirmed` the served file carries the completed Bitcoin attestation/, "must state the confirmed row serves the completed proof");
});
