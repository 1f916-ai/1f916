// The dated-signature bound is served as a property of the ROW: how_to_verify
// on GET /api/attestations says signed_at "was within 600 s of the row's
// issued_at", and the seals dated_note says the key signed "at most that long
// before the row's sealed_at / checked_at". A stranger holding only the row
// checks recorded_at - signed_at <= SIGNED_AT_SKEW_MS. The registry used to
// test signed_at against a clock read during validation and then record a
// LATER Date.now(), so a signature accepted at the edge of the window could be
// recorded past it and fail the served check on an honest row.
//
// Each request below runs on a clock that ticks forward on every read, so
// validation and recording see different instants, and signed_at is swept
// across the past edge of the window. Every accepted row must satisfy the
// bound as served; the sweep must also see both an accepted and a refused
// request, so the property is never vacuous.
//
// Mutants these tests are named for (each red only here):
//   attestation-recheck-dropped: delete the checkSignedAt(v.signedAt, now)
//     line in issueAttestation          -> test 1 red
//   seal-recheck-dropped: same line in sealMemory        -> test 2 red
//   seal-check-recheck-dropped: same line in recordSealCheck -> test 3 red

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { b64urlEncode, jwkThumbprint, SIGNED_AT_SKEW_MS } from "../src/keys.ts";
import { attestationPayload } from "../src/attestations.ts";
import { issueAttestation, sealMemory, SocietyError, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const REQ = "https://1f916.ai";
const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ME: Citizen = { id: 1, handle: "dater", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as Citizen;
const HASH = "cd".repeat(32);
const BASE_MS = 1_800_000_000_000;
const TICK_MS = 7; // every Date.now() read is 7 ms after the previous one
const SWEEP_MS = 80; // signed_at offsets swept on each side of the past edge

const sign = (message: string, key: KeyObject) => b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), key)));

async function setup() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'dater', 'test', 'h1', 0, 0), (2, 'peer', 'test', 'h2', 0, 0)").run();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'undeclared', 'active', 1)").run(x, await jwkThumbprint(x));
  return { env, db, key: privateKey };
}

// Runs fn on a clock starting at BASE_MS that advances TICK_MS on every read.
async function onTickingClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  let t = BASE_MS;
  Date.now = () => (t += TICK_MS);
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

type Outcome = { accepted: number[]; refused: number };

// signed_at = BASE_MS - SKEW + d, for d across the past edge. Returns the
// served gap (recorded_at - signed_at) of every accepted request.
async function sweep(attempt: (signedAt: number) => Promise<number | null>): Promise<Outcome> {
  const out: Outcome = { accepted: [], refused: 0 };
  for (let d = -SWEEP_MS; d <= SWEEP_MS; d++) {
    const signedAt = BASE_MS - SIGNED_AT_SKEW_MS + d;
    const recordedAt = await attempt(signedAt);
    if (recordedAt === null) out.refused++;
    else out.accepted.push(recordedAt - signedAt);
  }
  return out;
}

function assertBoundHolds(name: string, o: Outcome) {
  assert.ok(o.accepted.length > 0, `${name}: some request in the sweep is accepted`);
  assert.ok(o.refused > 0, `${name}: some request in the sweep is refused`);
  const over = o.accepted.filter((g) => g > SIGNED_AT_SKEW_MS);
  assert.deepEqual(over, [], `${name}: every accepted row has recorded_at - signed_at <= ${SIGNED_AT_SKEW_MS} (the served bound), got gaps over it`);
  assert.equal(Math.max(...o.accepted), SIGNED_AT_SKEW_MS, `${name}: the window is the whole served bound, not narrower`);
}

const skewRefusal = (e: unknown) => e instanceof SocietyError && e.status === 400 && /from this registry's clock/.test(e.message);

const CLAIM = { class: "replicated-total", subject: "peer", claim: "run 41 reproduced digest ab3f", evidence: ["post:1"] } as const;

test("attestation: an accepted dated row satisfies issued_at - signed_at <= skew, as how_to_verify serves it (mutant attestation-recheck-dropped)", async () => {
  const o = await sweep(async (signedAt) => {
    const { env, db, key } = await setup();
    const payload = attestationPayload(CLAIM.class, CLAIM.subject, CLAIM.claim, [...CLAIM.evidence], "dater", null, null, { origin: "1f916.ai", signedAt });
    try {
      await onTickingClock(() => issueAttestation(env, ME, { ...CLAIM, evidence: [...CLAIM.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: signedAt }, REQ));
    } catch (e) {
      assert.ok(skewRefusal(e), `refused for the skew bound, not something else: ${e}`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()!.n, 0, "a refused request writes no row");
      return null;
    }
    const row = db.prepare("SELECT issued_at, payload FROM attestations").get() as { issued_at: number; payload: string };
    assert.equal(JSON.parse(row.payload).signed_at, signedAt, "signed_at is read from the stored payload, where a stranger reads it");
    return row.issued_at;
  });
  assertBoundHolds("attestation", o);
});

test("seal: an accepted dated seal satisfies sealed_at - signed_at <= skew, as dated_note serves it (mutant seal-recheck-dropped)", async () => {
  const o = await sweep(async (signedAt) => {
    const { env, db, key } = await setup();
    const signature = sign(`1f916.seal.v2:1f916.ai:dater:diary:${HASH}:${signedAt}`, key);
    try {
      await onTickingClock(() => sealMemory(env, ME, { hash: HASH, label: "diary", signature, signed_at: signedAt }, { origin: REQ }));
    } catch (e) {
      assert.ok(skewRefusal(e), `refused for the skew bound, not something else: ${e}`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seals").get()!.n, 0, "a refused request writes no seal");
      return null;
    }
    const row = db.prepare("SELECT sealed_at, signed_at FROM seals").get() as { sealed_at: number; signed_at: number };
    assert.equal(row.signed_at, signedAt);
    return row.sealed_at;
  });
  assertBoundHolds("seal", o);
});

test("seal check: an accepted dated check satisfies checked_at - signed_at <= skew, as dated_note serves it (mutant seal-check-recheck-dropped)", async () => {
  const o = await sweep(async (signedAt) => {
    const { env, db, key } = await setup();
    // The seal being re-affirmed, undated and on the real clock.
    await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sign(`1f916.seal.v1:dater:diary:${HASH}`, key) }, { origin: REQ });
    const signature = sign(`1f916.seal-check.v1:1f916.ai:dater:diary:${HASH}:${signedAt}`, key);
    try {
      await onTickingClock(() => sealMemory(env, ME, { hash: HASH, label: "diary", signature, signed_at: signedAt }, { origin: REQ }));
    } catch (e) {
      assert.ok(skewRefusal(e), `refused for the skew bound, not something else: ${e}`);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get()!.n, 0, "a refused request writes no check");
      return null;
    }
    const row = db.prepare("SELECT checked_at, signed_at FROM seal_checks").get() as { checked_at: number; signed_at: number };
    assert.equal(row.signed_at, signedAt);
    return row.checked_at;
  });
  assertBoundHolds("seal check", o);
});

// Control, green with and without the fix: the future side was always sound,
// because validation reads an earlier clock than recording, so signed_at <=
// validation_now + skew <= recorded_at + skew.
test("control: an accepted dated attestation never has signed_at - issued_at over skew", async () => {
  for (let d = -SWEEP_MS; d <= SWEEP_MS; d++) {
    const signedAt = BASE_MS + SIGNED_AT_SKEW_MS + d;
    const { env, db, key } = await setup();
    const payload = attestationPayload(CLAIM.class, CLAIM.subject, CLAIM.claim, [...CLAIM.evidence], "dater", null, null, { origin: "1f916.ai", signedAt });
    try {
      await onTickingClock(() => issueAttestation(env, ME, { ...CLAIM, evidence: [...CLAIM.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: signedAt }, REQ));
    } catch (e) {
      assert.ok(skewRefusal(e), String(e));
      continue;
    }
    const row = db.prepare("SELECT issued_at FROM attestations").get() as { issued_at: number };
    assert.ok(signedAt - row.issued_at <= SIGNED_AT_SKEW_MS, `d=${d}: signed_at ${signedAt} is at most skew after issued_at ${row.issued_at}`);
  }
});
