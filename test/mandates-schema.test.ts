// GET /api/mandates always serves contract / what_this_is / mandates / has_more /
// next_since_id / caps (router adds now/now_utc). There was no published schema,
// so a clipped page missing has_more had no contract to fail. Soft-power adds
// schemas/mandates.json. next_since_id is ALWAYS required (rail-events shape),
// not omit-on-final.
//
// Killing mutations:
//   1. Drop has_more from required — incomplete fixture validates.
//   2. Drop next_since_id from required — always-cursor lie returns.
//   3. Drop caps from required — catalogue ceiling disappears from contract.
//
// Soft-power / cloudymcclouder. Complements soft-power/mandates-anchors-surface-
// caps (#483) which bound SURFACE to MANDATE_PAGE; this PR pins the response.
// Not cloudy/*; not gooseberry/clients/*. Specimen fixtures only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { validate } from "./helpers/json-schema.ts";
import { createMandate, addOutcome, listMandates, mandateSigMessage, sha256Hex } from "../src/mandates.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env, Citizen } from "../src/society.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/mandates.json", import.meta.url)), "utf8"),
);

const row = {
  id: 1,
  citizen: "1f916-agent",
  label: "maintainer.deploy",
  subject: null,
  signed: false,
  signature: null,
  key_thumbprint: null,
  signed_message: null,
  created_at: 1,
  public: false,
  instruction_hash: "4fe11cb2409c556d9e339b0aa6d7090e8f2a72a3f6bafb38848b43ebf0f05e2a",
  action_hash: "c28348e2e61b0a42a40e60ce7c29a5b912302b6bf4f5ee8c97a1489b404ee38a",
  outcome_hash: "b454c835077396bbdc51428e8d5f71d725ed6a29e3cfc359698a2487e040a12c",
  commit: "b4577b90bcf5a1c2e539367ffc54c374ae37fed95d898e95b73af8b7d93f54a9",
  commit_payload:
    "1f916.mandate.v1:1f916-agent:1:4fe11cb2409c556d9e339b0aa6d7090e8f2a72a3f6bafb38848b43ebf0f05e2a:c28348e2e61b0a42a40e60ce7c29a5b912302b6bf4f5ee8c97a1489b404ee38a:b454c835077396bbdc51428e8d5f71d725ed6a29e3cfc359698a2487e040a12c",
  seal: {
    id: 7671,
    label: "mandate",
    chained: "88aaa91eb8b2efa1e1d5d4516e6e6605903743311b92e930755e397d6cc79c1a",
  },
  stored: { instruction: false, action: false, outcome: false, envelope: false },
  envelope_bytes: null,
  envelope_format: null,
  page: "/mandates/1",
  record: "/api/record/1f916-agent",
  has_outcome: true,
  outcome_added: null,
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.mandates.v1",
    what_this_is: "Mandates: what an agent was told.",
    mandates: [row],
    has_more: false,
    next_since_id: 1,
    caps: {
      per_response: 100,
      unit: "mandates, oldest-first by id",
      more: "follow next_since_id as ?since_id= while has_more",
    },
    ...overrides,
  };
}

test("mandates.json requires has_more, next_since_id, and caps", () => {
  for (const key of ["has_more", "next_since_id", "caps", "contract", "mandates", "what_this_is"]) {
    assert.ok(schema.required.includes(key), `required must include ${key}`);
  }
});

test("a final page with always-served next_since_id validates", () => {
  assert.deepEqual(validate(schema, base()), []);
});

test("empty page still requires next_since_id (always-cursor)", () => {
  assert.deepEqual(
    validate(schema, base({ mandates: [], has_more: false, next_since_id: 0 })),
    [],
  );
  const missing = base({ mandates: [], has_more: false });
  delete (missing as { next_since_id?: number }).next_since_id;
  assert.ok(validate(schema, missing).some((e) => /next_since_id/.test(e)), validate(schema, missing).join("; "));
});

test("dropping has_more must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { has_more?: boolean }).has_more;
  assert.ok(validate(schema, incomplete).some((e) => /has_more/.test(e)));
});

test("has_more:true with next_since_id validates", () => {
  assert.deepEqual(validate(schema, base({ has_more: true, next_since_id: 100 })), []);
});

test("caps.per_response is MANDATE_PAGE (100)", () => {
  assert.equal(schema.properties.caps.properties.per_response.const, 100);
  const bad = base({ caps: { per_response: 200, unit: "x", more: "y" } });
  assert.ok(validate(schema, bad).some((e) => /per_response|const|100/.test(e)), validate(schema, bad).join("; "));
});

test("description names always-served next_since_id and has_more", () => {
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /next_since_id/);
  assert.match(schema.description, /ALWAYS|always served|rail-events/i);
});

// WQ-308 (0xRyanC, during PR #446): schemas/mandates.json was additionalProperties:
// false and listed only a SUBSET of the fields view() serves on every list row —
// it omitted subject, signed, signature, key_thumbprint, signed_message,
// envelope_format, has_outcome, outcome_added — so a strict validator rejected a
// real GET /api/mandates response. The hand fixture above never caught it because
// it was built from the same subset. This test validates the ACTUAL listMandates
// output against the published schema, so the contract cannot silently re-drift
// from view().
//
// Killing mutation: delete any of the eight added fields from schemas/mandates.json
// $defs.mandateListRow (its value then becomes an extra under additionalProperties:
// false, or a missing required) -> the real-row validation below returns errors.

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const IH = "1".repeat(64);
const AH = "2".repeat(64);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: b64u(raw), sign: (msg: string) => b64u(edSign(null, Buffer.from(msg, "utf8"), privateKey)) };
}

function served() {
  const { env, db } = sqliteTestEnv(SCHEMA_SQL);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'bank', 'test-model', 'h1', 0, 0)`);
  const kv = new Map<string, string>();
  const e = { ...env, RECORDS: { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null } as unknown as KVNamespace } as Env;
  return { env: e, db, bank: { id: 1, handle: "bank" } as Citizen };
}

test("a real GET /api/mandates response validates against schemas/mandates.json (view() shape)", async () => {
  const { env, db, bank } = served();
  const T0 = 1_790_000_000_000;

  // (1) a plain mandate: unsigned, no subject, no outcome -> the null/false branch
  // of every added field (subject, signed, signature, key_thumbprint,
  // signed_message, envelope_format null; outcome_added null).
  await createMandate(env, bank, { instruction_hash: IH, action_hash: AH }, T0);

  // (2) signed + subject, then an outcome added later -> the non-null branch of
  // signature/key_thumbprint/signed_message and a non-null outcome_added object.
  const k = keypair();
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, 'thumb-1', 'undeclared', 'active', 0)").run(k.publicKey);
  const sh = await sha256Hex("user:7f3a");
  const signature = k.sign(mandateSigMessage("bank", IH, AH, null, sh));
  const m2 = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:7f3a", signature }, T0 + 1);
  await addOutcome(env, bank, m2.id, { outcome: "done" }, T0 + 2);

  const resp = { now: 1, now_utc: new Date(1).toISOString(), ...(await listMandates(env, null, undefined, null)) };
  assert.equal(resp.mandates.length, 2, "both seeded mandates are listed");
  assert.deepEqual(validate(schema, resp), [], "the real two-row response validates against the published schema");

  // The served rows really do carry the fields the old schema omitted (so the
  // validation above is non-vacuous, not passing on an empty/absent set).
  const signedRow = resp.mandates.find((r) => (r as { signed: boolean }).signed) as Record<string, unknown>;
  assert.ok(signedRow, "one row is signed");
  assert.equal(signedRow.key_thumbprint, "thumb-1");
  assert.equal(typeof signedRow.signed_message, "string");
  assert.equal(signedRow.subject, "user:7f3a");
  assert.ok(signedRow.outcome_added && typeof signedRow.outcome_added === "object", "outcome_added is an object on the row with a later outcome");
});
