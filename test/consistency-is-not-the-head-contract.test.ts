// A SHAPE MARKER MUST NAME THE SHAPE IT IS ON.
//
// WHY THIS FILE EXISTS. PR #227 added a `contract` marker to four board read
// endpoints so a client can pick a parser without guessing. It also added the
// SAME marker to consistency(), which serves a different object entirely:
// { log, from, to, proof, how_to_verify }, with no registry_public_key, no
// witness_dispatch and no checkpoints. schemas/checkpoint.json pins
// `1f916.checkpoint.v1` as a const for the HEAD response, so the consistency
// proof was claiming a contract whose schema it does not satisfy.
//
// That shipped. Measured against production on 2026-09-12T06:23Z, live
// GET /api/checkpoint/consistency?log=ledger&from=5&to=11 returned
// contract "1f916.checkpoint.v1" on a body keyed
// {contract, from, how_to_verify, log, now, now_utc, proof, to}. A client
// pinning `contract` to select a parser would have read a consistency proof as
// a checkpoint head. A marker that names the wrong contract is worse than no
// marker, because it is confidently wrong.
//
// The marker is removed rather than replaced. Giving consistency its own
// contract value is a real decision: it needs a schema, a probe entry and a
// version, and inventing one while fixing someone else's defect is how scope
// creeps. If that value is wanted it should arrive as its own change.
//
// KILLING MUTATION: put `contract: CHECKPOINT_PAYLOAD_PREFIX,` back into the
// object returned by consistency() in src/checkpoint.ts. This goes red.
//
// The HEAD's marker, which is correct, is already guarded by the contributor's
// own test/board-read-contract-served.test.ts. Asserting it again here would
// duplicate their coverage, so this file guards only the gap they left.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { consistency } from "../src/checkpoint.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  // Two checkpoints on one log, so a consistency proof between them exists.
  for (const [size, root] of [[1, "r1"], [2, "r2"]] as [number, string][]) {
    db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('ledger', ?, ?, 's', 1)").run(size, root);
  }
  // SEALED rows, not merely present: sealedHashes() selects `hash IS NOT NULL`,
  // and consistency() refuses with "log shorter than checkpointed size" if the
  // log has fewer sealed leaves than the checkpointed tree_size. The first
  // version of this fixture inserted rows without a hash, consistency() threw,
  // and a try/catch here swallowed it — the test passed while asserting
  // nothing. That is the exact defect this file was written to catch, so the
  // catch is gone and a broken fixture now fails loudly.
  db.prepare("INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, hash) VALUES (1, '2026-01-01', 'a', 1, 1, 'aa'), (2, '2026-01-02', 'b', 2, 2, 'bb')").run();
  return env;
}

test("a consistency proof does not claim the checkpoint head's contract", async () => {
  const env = seeded();
  const body = (await consistency(env, "ledger", "1", "2")) as Record<string, unknown>;
  assert.equal(
    body.contract,
    undefined,
    `consistency serves ${JSON.stringify(body.contract)}; that value is a const in schemas/checkpoint.json for the HEAD response, and this body is ${JSON.stringify(Object.keys(body).sort())}`,
  );
});
