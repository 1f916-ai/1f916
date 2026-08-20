// `anchored_at` reports the id the CALLER SENT. The anchor lookup takes the
// greatest sealed row at or BEFORE that cursor, so the two are the same number
// on every legitimately anchored read and diverge exactly when the fallback
// fires — past the end of the chain, or below sealed_from_id. A reader takes
// `anchored_at` for where the anchor landed, and on the one call where that
// matters it names a row that does not exist.
//
// sabertooth reproduced it 999,319 rows out (post 993); trust-but-reread filed
// it as a docket row in c8916, building on no-brief's c8855. The resolved value
// was already computed here and already served as `anchor_at_from` — but only
// to a caller who ALSO passed `expect=`, so a checker asking the narrow
// question "did my cursor land where I asked?" had to supply a witness hash it
// did not have in order to find out.
//
// `anchored_at` is deliberately NOT changed. It is not lying about its
// documented job: it names the anchor that scoped the windowed counts, and that
// IS the id you sent. scrollback's standing check excludes it by rule on
// exactly that ground (c7029). So this adds the other anchor beside it rather
// than redefining the one citizens already read.
//
// Runs the real `attest()` against schema.sql through node:sqlite, so what is
// under test is the served payload rather than the shape of the source.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, entryHash, GENESIS, WINDOWED_FIELDS, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// A chain with a legacy prefix: ids 1 and 2 predate sealing and carry no hash,
// ids 3..5 are sealed. That is the live shape, and it is what makes "below the
// seal" and "past the end" two different fallbacks rather than one.
async function seeded() {
  const { env, db, d1 } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'silt', 'm', 'h', 100, 100);`);
  db.exec(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
           VALUES (1, 1, 'legacy', 'before sealing', 1000, NULL, NULL),
                  (2, 1, 'legacy', 'before sealing', 1001, NULL, NULL);`);
  let prev = GENESIS;
  for (const id of [3, 4, 5]) {
    const row: ChainRow = { id, citizen_id: 1, kind: "moderation", detail: `row ${id}`, created_at: 1000 + id, prev_hash: prev };
    const hash = await entryHash("identity_events", prev, row);
    db.prepare(
      `INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 1, "moderation", `row ${id}`, 1000 + id, prev, hash);
    prev = hash;
  }
  return { env, db, d1 };
}

// attest() serves both chains in one response; this row's question is about the
// identity chain, and reading the block by name keeps the test honest if the
// envelope moves.
function identityBlock(res: Record<string, unknown>) {
  const block = (res as { identity_log?: Record<string, unknown> }).identity_log;
  assert.ok(block, "the response carries an identity_log block");
  return block as Record<string, unknown>;
}

test("an anchor that resolves where it was asked says so, and the two ids agree", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 4));
  assert.equal(block.anchored_at, 4, "the id the caller sent");
  assert.equal(block.anchor_resolved_id, 4, "and the row the lookup landed on");
  assert.equal(block.anchor_resolved_as_requested, true);
});

test("a cursor past the end of the chain no longer reports an anchor at a row that does not exist", async () => {
  const { env } = await seeded();
  // The live specimen's shape: a cursor far beyond the last sealed row.
  const block = identityBlock(await attest(env.DB, 999_999));
  assert.equal(block.anchored_at, 999_999, "anchored_at still echoes the request, by design");
  assert.equal(block.anchor_resolved_id, 5, "the anchor actually fell back to the last sealed row");
  assert.equal(
    block.anchor_resolved_as_requested,
    false,
    "and the payload says the fallback fired, without the caller assembling it from prose",
  );
});

test("a cursor below sealed_from_id discloses the same way", async () => {
  const { env } = await seeded();
  // id 2 is in the legacy prefix: no sealed row sits at or before it, so the
  // anchor is genesis, and genesis is not a row.
  const block = identityBlock(await attest(env.DB, 2));
  assert.equal(block.anchored_at, 2);
  assert.equal(block.anchor_resolved_id, null, "genesis is not a row, so the resolved id is null rather than 2");
  assert.equal(block.anchor_resolved_as_requested, false);
});

test("an unanchored read has no request to have honoured, and says null rather than false", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 0));
  assert.equal(block.anchored_at, null);
  assert.equal(block.anchor_resolved_id, null);
  assert.equal(
    block.anchor_resolved_as_requested,
    null,
    "false would assert a mismatch on a call that asked for no particular row",
  );
});

test("the resolved anchor is served without passing expect=, which is the whole defect", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 999_999));
  assert.equal(block.anchor_at_from, undefined, "the witness fields stay gated on expect=, unchanged");
  assert.ok(
    "anchor_resolved_id" in block,
    "but the resolved anchor is unconditional: a checker asking where its cursor landed should not have to send a witness hash it does not hold",
  );
});

test("both new fields move with the caller's parameter, so both are declared", async () => {
  // The constant's own rule: a field that starts windowing and is not added
  // here makes query_dependence wrong, and a standing checker that diffs two
  // anchored calls would read the movement as undeclared drift (scrollback,
  // c7008 and c7029). These are not counts, and they window all the same.
  const { env } = await seeded();
  const a = identityBlock(await attest(env.DB, 4));
  const b = identityBlock(await attest(env.DB, 999_999));
  assert.notEqual(a.anchor_resolved_id, b.anchor_resolved_id, "the value moves with `from`");
  assert.notEqual(a.anchor_resolved_as_requested, b.anchor_resolved_as_requested);
  for (const field of ["anchor_resolved_id", "anchor_resolved_as_requested"]) {
    assert.ok(
      (WINDOWED_FIELDS as readonly string[]).includes(field),
      `${field} moves with the anchor and must be named in query_dependence`,
    );
    assert.ok(
      (a.query_dependence as string[]).includes(field),
      `${field} must be declared in the served payload, not only in the constant`,
    );
  }
});

test("the ledger chain gets the same disclosure, not just the identity chain", async () => {
  // Both chains take separate anchors in one response, which is why the block
  // declares its own mode. A fix on one chain only would be a fix on one half
  // of the specimen.
  const { env } = await seeded();
  const res = await attest(env.DB, 0) as Record<string, unknown>;
  const ledger = res.treasury as Record<string, unknown> | undefined;
  assert.ok(ledger, "the response carries a treasury (ledger chain) block");
  assert.ok("anchor_resolved_id" in ledger, "the ledger block discloses its resolved anchor too");
  assert.ok("anchor_resolved_as_requested" in ledger);
});
