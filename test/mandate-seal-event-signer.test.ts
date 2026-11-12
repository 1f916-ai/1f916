// WQ-MANDATE-EVENT-WORDING (head-of-experiments, #11825). POST /api/mandates
// seals sha256(commit_payload); the mandate's Ed25519 signature rides INSIDE
// commit_payload (one hash layer in), not over the seal, so the memory.seal
// event detail read "unsigned (bearer-authenticated)" for every mandate — a
// chain-event census could not tell a key-signed mandate from a bearer-only
// one (the author measured 152/152 reading bearer-only).
//
// The seal is genuinely unsigned AT THE SEAL LEVEL, so that claim stays; the
// fix appends the VERIFIED in-commit signer's thumbprint when there is one,
// without claiming the seal itself was signed.
//
// Killing mutation: drop the `opts.inCommitSigner ? ... : ""` suffix from the
// memory.seal detail (society.ts) -> the key-signed assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { createMandate, mandateSigMessage } from "../src/mandates.ts";
import { type Env, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T0 = 1_790_000_000_000;
const IH = "1".repeat(64);
const AH = "2".repeat(64);
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: b64u(raw), sign: (msg: string) => b64u(edSign(null, Buffer.from(msg, "utf8"), privateKey)) };
}

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'bank', 'test-model', 'h1', 0, 0)`);
  const bindKey = (thumbprint: string, publicKey: string) =>
    db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'undeclared', 'active', 0)").run(publicKey, thumbprint);
  const lastSealDetail = () =>
    String((db.prepare("SELECT detail FROM identity_events WHERE kind = 'memory.seal' ORDER BY id DESC LIMIT 1").get() as { detail: string }).detail);
  return { env: env as Env, db, bindKey, lastSealDetail, bank: { id: 1, handle: "bank" } as Citizen };
}

test("a key-signed mandate's memory.seal event names the verified in-commit signer", async () => {
  const { env, bindKey, lastSealDetail, bank } = fixture();
  const k = keypair();
  bindKey("thumb-xyz", k.publicKey);
  const signature = k.sign(mandateSigMessage("bank", IH, AH, null, null));
  const m = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature }, T0);
  assert.equal(m.signed, true);
  assert.equal(m.key_thumbprint, "thumb-xyz");
  const detail = lastSealDetail();
  // The seal-level claim is unchanged (the seal carries no signature)...
  assert.match(detail, /unsigned \(bearer-authenticated\)/);
  // ...and the verified in-commit signer is named, so a census can tell.
  assert.match(detail, /; signed in the sealed commit by thumb-xyz$/);
});

test("a bearer-only mandate's memory.seal event carries no in-commit signer suffix", async () => {
  const { env, lastSealDetail, bank } = fixture();
  const m = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH }, T0);
  assert.equal(m.signed, false);
  const detail = lastSealDetail();
  assert.match(detail, /unsigned \(bearer-authenticated\)$/, "ends at the bearer claim, no in-commit signer");
  assert.doesNotMatch(detail, /signed in the sealed commit/);
});
