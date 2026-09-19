// /api/checkpoint/consistency had no schema. Public RFC 6962 consistency proof
// between two signed checkpoints (log + from/to tree sizes) is a live 200 and
// the verifier that walks "append-only-ness" from GET /api/checkpoint's
// how_to_verify has nothing to pin the contract against. A dropped proof, an
// uppercase root, a fabricated log name, or a from/to object missing tree_size
// would be a contract break the live lane could not see.
//
// The body is served by consistency() (src/checkpoint.ts) plus the router's
// json() clock. All required top-level keys are ALWAYS present on a 200.
// from/to are SELECT tree_size, root, sig, created_at — no id (unlike
// /api/proof's covering checkpoint). proof may be empty when from === to.
// Proven RED first: without schemas/checkpoint-consistency.json the file fails
// to load.
//
// Soft-power / cloudymcclouder. No overlap with Cloudy #316 (witness history)
// or #318 (/api/proof inclusion). Babysit #313/#314/#315/#317; leave cloudy/*
// alone. Hunt: public consistency schema was the unowned deferred option.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "checkpoint-consistency.json"), "utf8"));

const LOGS = ["identity_events", "ledger"] as const;
const ROOT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROOT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOT_C = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const SIB_1 = "1111111111111111111111111111111111111111111111111111111111111111";
const SIB_2 = "2222222222222222222222222222222222222222222222222222222222222222";
const SIG = "plcIP9ONx-YcPttlTiYcFKpqADik6F5QU1awIDkqXaFP90fXL5GFW19dO2GIeuiyeEWvi34YAbyX60iPusEKCw";

const now = 1789853068927;
const nowUtc = new Date(now).toISOString();

function checkpoint(over: Record<string, unknown> = {}) {
  return {
    tree_size: 11,
    root: ROOT_B,
    sig: SIG,
    created_at: 1788327958382,
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    log: "ledger",
    from: checkpoint({ tree_size: 5, root: ROOT_A, created_at: 1786500831118 }),
    to: checkpoint(),
    proof: [SIB_1, SIB_2],
    how_to_verify:
      "RFC 6962 §2.1.2 (RFC 9162 §2.1.4.2): the proof reconstructs BOTH roots from the shared prefix.",
    ...over,
  };
}

test("the checkpoint-consistency schema accepts the served contract (diff + tip→tip + both logs)", () => {
  // Live-shaped ledger from=5 to=11 specimen (soft-power, 2026-09-19 ~17:24 ET).
  assert.deepEqual(validate(schema, body()), [], "live-shaped non-empty proof validates");

  // Tip→tip: proof=[] is legitimate (consistencyProof returns [] when from === to).
  const tip = body({
    log: "identity_events",
    from: checkpoint({ tree_size: 17850, root: ROOT_C, created_at: 1789853117965 }),
    to: checkpoint({ tree_size: 17850, root: ROOT_C, created_at: 1789853117965 }),
    proof: [],
  });
  assert.deepEqual(validate(schema, tip), [], "empty tip→tip proof validates");

  for (const log of LOGS) {
    assert.deepEqual(
      validate(schema, body({ log })),
      [],
      `log ${log} validates`,
    );
  }
});

test("the checkpoint-consistency schema refuses the contract breaks it exists to catch", () => {
  const missingProof = body();
  delete (missingProof as { proof?: unknown }).proof;
  assert.ok(
    validate(schema, missingProof).some((e) => /proof/.test(e)),
    "dropped proof loses the append-only bytes this schema exists to pin",
  );

  const missingFrom = body();
  delete (missingFrom as { from?: unknown }).from;
  assert.ok(
    validate(schema, missingFrom).some((e) => /from/.test(e)),
    "dropped from loses one of the two signed heads",
  );

  const upperRoot = body({
    from: checkpoint({ tree_size: 5, root: ROOT_A.toUpperCase() }),
  });
  assert.ok(
    validate(schema, upperRoot).some((e) => /root/.test(e)),
    "an uppercase root is not a chain hash",
  );

  const badLog = body({ log: "comments" });
  assert.ok(
    validate(schema, badLog).some((e) => /log/.test(e)),
    "a log outside LOGS is refused",
  );

  const shortHash = body({ proof: [SIB_1.slice(0, 63)] });
  assert.ok(
    validate(schema, shortHash).some((e) => /proof/.test(e)),
    "a short proof sibling is refused",
  );

  const noHow = body();
  delete (noHow as { how_to_verify?: string }).how_to_verify;
  assert.ok(
    validate(schema, noHow).some((e) => /how_to_verify/.test(e)),
    "dropped how_to_verify loses the verification recipe",
  );

  const noNow = body();
  delete (noNow as { now?: number }).now;
  assert.ok(
    validate(schema, noNow).some((e) => /now/.test(e)),
    "now is the HTTP wrapper clock",
  );

  // Consistency from/to do NOT serve id — requiring one would be the /api/proof shape.
  const withIdOnly = {
    now,
    now_utc: nowUtc,
    log: "ledger",
    from: { id: 1, tree_size: 5, root: ROOT_A, sig: SIG, created_at: 1 },
    to: { id: 2, tree_size: 11, root: ROOT_B, sig: SIG, created_at: 2 },
    proof: [],
    how_to_verify: "x",
  };
  // additionalProperties are ignored by the subset validator; instead drop tree_size.
  const noTreeSize = body({
    from: { root: ROOT_A, sig: SIG, created_at: 1 },
  });
  assert.ok(
    validate(schema, noTreeSize).some((e) => /tree_size/.test(e)),
    "a from missing tree_size is named",
  );

  const stringSize = body({
    to: checkpoint({ tree_size: "11" }),
  });
  assert.ok(
    validate(schema, stringSize).some((e) => /tree_size/.test(e)),
    "a string where tree_size is promised as an integer is refused",
  );

  void withIdOnly; // documents the deliberate non-requirement of id
});

test("the checkpoint-consistency schema description pins the public / RFC 6962 framing", () => {
  assert.match(
    schema.description,
    /public|Public|unauth/i,
    "the schema names that the live lane can probe this endpoint",
  );
  assert.match(
    schema.description,
    /6962|append-only|consistency/i,
    "the schema names the RFC 6962 consistency / append-only framing",
  );
  assert.match(
    schema.description,
    /identity_events/,
    "the schema names identity_events as a log",
  );
  assert.match(
    schema.description,
    /ledger/,
    "the schema names ledger as a log",
  );
  const rowDesc = schema.$defs?.consistencyCheckpoint?.description ?? "";
  assert.match(rowDesc, /no id|does not serve id/i, "row def pins the no-id SELECT shape");
});

test("the checkpoint-consistency schema matches what /api/checkpoint/consistency actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating consistency()'s return alone
  // would miss the clock. Same idiom as the /api/rail-events schema test (#317).
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;

  const leaf1 = "aa".repeat(32);
  const leaf2 = "bb".repeat(32);
  const leaf3 = "cc".repeat(32);
  const root1 = "dd".repeat(32);
  const root2 = "ee".repeat(32);
  const root3 = "ff".repeat(32);
  const sig = "dGVzdC1zaWc"; // base64url-ish

  // Sealed ledger leaves: sealedHashes() selects hash IS NOT NULL ORDER BY id.
  db.exec(`
    INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, hash) VALUES
      (1, '2026-01-01', 'a', 1, 1, '${leaf1}'),
      (2, '2026-01-02', 'b', 2, 2, '${leaf2}'),
      (3, '2026-01-03', 'c', 3, 3, '${leaf3}');
    INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES
      ('ledger', 1, '${root1}', '${sig}', 10),
      ('ledger', 2, '${root2}', '${sig}', 20),
      ('ledger', 3, '${root3}', '${sig}', 30);
  `);

  // Tip→tip: empty proof.
  const tipRes = await worker.fetch(
    new Request("http://t/api/checkpoint/consistency?log=ledger&from=3&to=3"),
    full,
  );
  assert.equal(tipRes.status, 200, "tip→tip is a 200");
  const tipServed = await tipRes.json();
  assert.deepEqual(
    validate(schema, tipServed),
    [],
    "the schema must accept the tip→tip page /api/checkpoint/consistency serves today",
  );
  assert.equal((tipServed as { proof: unknown[] }).proof.length, 0, "tip→tip proof is empty");
  assert.equal((tipServed as { log: string }).log, "ledger");

  // Diff sizes: non-empty proof.
  const diffRes = await worker.fetch(
    new Request("http://t/api/checkpoint/consistency?log=ledger&from=1&to=3"),
    full,
  );
  assert.equal(diffRes.status, 200, "diff sizes are a 200");
  const diffServed = await diffRes.json();
  assert.deepEqual(
    validate(schema, diffServed),
    [],
    "the schema must accept what /api/checkpoint/consistency serves for a non-empty proof",
  );
  assert.ok(
    (diffServed as { proof: string[] }).proof.length >= 1,
    "from < to yields at least one sibling",
  );
  assert.equal((diffServed as { from: { tree_size: number } }).from.tree_size, 1);
  assert.equal((diffServed as { to: { tree_size: number } }).to.tree_size, 3);
  // No id on from/to (the SELECT omits it).
  assert.equal(
    Object.prototype.hasOwnProperty.call((diffServed as { from: object }).from, "id"),
    false,
    "from does not carry id",
  );

  // Bad log → 400 (not a schema page).
  const badLog = await worker.fetch(
    new Request("http://t/api/checkpoint/consistency?log=nope&from=1&to=1"),
    full,
  );
  assert.equal(badLog.status, 400);

  // Missing size → 404 naming the operand.
  const miss = await worker.fetch(
    new Request("http://t/api/checkpoint/consistency?log=ledger&from=1&to=99"),
    full,
  );
  assert.equal(miss.status, 404);
});
