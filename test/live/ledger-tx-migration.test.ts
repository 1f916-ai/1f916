// A migration that touches the books, checked before it is allowed to run.
//
// Docket row ledger-flaggable, second part: seven legacy rows carry a real
// transaction hash inside their description text with the tx column NULL, so
// an auditor joining our income to Base has to parse our English. migration
// 0030 lifts each hash into its own column.
//
// This is a write to the books, so it is HELD rather than run on the
// maintainer's say-so, and these tests are what makes the held file
// reviewable: they check that the values were not invented, that the change
// cannot disturb a single hash, and that the rule which produced them
// reproduces the one row already known to be correct.

import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_PROBES, LIVE_SKIP_REASON, liveFetch } from "../helpers/live.ts";
import { readFileSync } from "node:fs";

const BASE = "https://1f916.ai";
const migration = readFileSync(new URL("../../migrations/0030_ledger_tx_out_of_prose.sql", import.meta.url), "utf8");

// id -> tx, parsed from the migration itself so the test reads what would run.
const proposed = new Map<number, string>();
for (const m of migration.matchAll(/UPDATE ledger SET tx = '(0x[0-9a-f]{64})' WHERE id = (\d+) AND tx IS NULL;/g)) {
  proposed.set(Number(m[2]), m[1]);
}

test("live: every proposed hash is already present in that row's own description", async (t) => {
  // #151: these three read the deployment, so they run only when the live
  // probes are asked for. A throttled read waits once and then fails rather
  // than skipping, because a probe that did not run is not a probe that passed.
  if (!LIVE_PROBES) return t.skip(LIVE_SKIP_REASON);
  // The values are not looked up anywhere or reconstructed. They are copied
  // out of the same row's text, so this test is the whole provenance claim:
  // nothing new is being introduced to the books.
  const r = await liveFetch(`${BASE}/treasury`, { headers: { "User-Agent": "1f916-ledger-tx-check/1.0" } });
  assert.ok(r.ok, `/treasury -> ${r.status}`);
  const body = (await r.json()) as { entries: { id: number; description: string; tx: string | null }[] };
  const byId = new Map(body.entries.map((e) => [e.id, e]));

  for (const [id, tx] of proposed) {
    const row = byId.get(id);
    assert.ok(row, `ledger row ${id} is not in the published books`);
    assert.ok(row!.description.includes(tx), `row ${id}: proposed tx is not in its own description`);
    // Exactly one candidate, so no judgement was exercised in choosing.
    const found = row!.description.match(/0x[0-9a-fA-F]{64}/g) ?? [];
    assert.equal(found.length, 1, `row ${id} contains ${found.length} transaction hashes; the migration would be choosing`);
  }
});

test("live: the control row reproduces, and the migration leaves it alone", async (t) => {
  // #151: these three read the deployment, so they run only when the live
  // probes are asked for. A throttled read waits once and then fails rather
  // than skipping, because a probe that did not run is not a probe that passed.
  if (!LIVE_PROBES) return t.skip(LIVE_SKIP_REASON);
  // Row 11 is the only legacy row whose tx column was already populated. If
  // the extraction rule is sound it must agree with that row exactly. This is
  // the difference between a rule that works and a rule nobody tested.
  const r = await liveFetch(`${BASE}/treasury`, { headers: { "User-Agent": "1f916-ledger-tx-check/1.0" } });
  const body = (await r.json()) as { entries: { id: number; description: string; tx: string | null }[] };
  const control = body.entries.find((e) => e.id === 11);
  assert.ok(control, "row 11 exists");
  const found = control!.description.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  assert.equal(found.length, 1);
  assert.equal(found[0], control!.tx, "the stored tx and the one in its prose agree character for character");
  assert.ok(!proposed.has(11), "row 11 needs nothing and must not be in the migration");
});

test("live: every proposed row now carries exactly the proposed tx, and it still matches its own prose", async (t) => {
  // #151: these three read the deployment, so they run only when the live
  // probes are asked for. A throttled read waits once and then fails rather
  // than skipping, because a probe that did not run is not a probe that passed.
  if (!LIVE_PROBES) return t.skip(LIVE_SKIP_REASON);
  // WAS a pre-flight check that nothing proposed had a tx yet, which passed
  // for three days while the migration sat unrun and then correctly failed the
  // moment it ran (2026-08-17). A premise check that has served its premise is
  // dead weight; converted here into the standing invariant instead of being
  // deleted, because the thing worth guarding forever is not "this has not
  // happened yet" but "what landed is what was proposed, and it is still
  // checkable against the copy the chain covers".
  const r = await liveFetch(`${BASE}/treasury`, { headers: { "User-Agent": "1f916-ledger-tx-check/1.0" } });
  const body = (await r.json()) as { entries: { id: number; description: string; tx: string | null }[] };
  let seen = 0;
  for (const e of body.entries) {
    const want = proposed.get(e.id);
    if (!want) continue;
    seen++;
    assert.equal(e.tx, want, `row ${e.id} does not carry the value the migration proposed`);
    assert.ok(
      e.description.includes(want),
      `row ${e.id}: tx is outside the hash preimage, so the copy inside the hashed description is the only thing that makes it checkable, and it is gone`,
    );
  }
  assert.equal(seen, proposed.size, "every proposed row is still present on the live ledger");
});
