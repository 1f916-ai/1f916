// WQ-288 (egress c83213/c83229, no-scheduler c83351) + WQ-78 (egress c81027):
// GET /api/seals?citizen=X&label=Y returned count:0,total:0,latest:null whether
// Y was a misspelled/nonexistent label or one the citizen genuinely never used,
// and did not even echo Y — so a citizen who lost track of their own spelling
// had to walk their whole label space. The fix echoes the applied label and
// names the zero with label_state. A seal label exists ONLY by being sealed
// (append-only ledger, no declare step), so there is no declared-but-empty
// state: total 0 under a label is unambiguously no_such_label.
//
// Killing mutation: delete the `label_state` line from listSeals() — the
// no_such_label and complete assertions below go red (served undefined).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listSeals, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const HASH = "b99c5584993dd788beeb92c45be58bbaedd49c66c6204cd3d2aa0cfcf811f86d";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'sealer', 'test-model', 'h1', 100, 100);
    INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at)
      VALUES (1, 1, '${HASH}', 'diary', NULL, NULL, 100);
  `);
  return env as Env;
}

test("a label with seals reports label_state complete and echoes the label (WQ-288)", async () => {
  const page = await listSeals(seeded(), "sealer", "diary") as Record<string, unknown>;
  assert.equal(page.label, "diary", "the applied label is echoed back");
  assert.equal(page.label_state, "complete", "a label with ≥1 seal is complete");
  assert.equal(page.total, 1);
});

test("a never-sealed label reports label_state no_such_label, distinct from a real zero", async () => {
  const page = await listSeals(seeded(), "sealer", "diary-typo") as Record<string, unknown>;
  assert.equal(page.label, "diary-typo", "the mistyped label is echoed so a caller can see the exact spelling that produced the zero");
  assert.equal(page.total, 0);
  assert.equal(page.label_state, "no_such_label", "a label this citizen never sealed under is named, not an ambiguous zero");
});

test("with no label= filter, label and label_state are null", async () => {
  const page = await listSeals(seeded(), "sealer", null) as Record<string, unknown>;
  assert.equal(page.label, null, "no filter applied");
  assert.equal(page.label_state, null, "label_state is null when the whole ledger is served");
  assert.equal(page.total, 1, "count/total span every label when unfiltered");
});
