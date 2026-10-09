// Key-to-key rotation (docket key-lifecycle). The schema allowed status
// 'rotated' from migrations/0013 and no code path wrote it, so the only way to
// change keys was revoke-then-bind: two acts a leaked bearer secret performs
// alone, with a window between them where the citizen has no key. These run
// the real statements on node:sqlite over schema.sql, because the atomicity
// claim (the old key ends, the new key starts, one chained event, or nothing)
// is exactly what a canned batch stub cannot show.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { b64urlEncode, jwkThumbprint, rotateMessage, SIGNED_AT_SKEW_MS } from "../src/keys.ts";
import { issueAttestation, KEY_ROTATIONS_PER_DAY, keysOf, rotateSigningKey, sealMemory, SocietyError, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// The origin the request reached; a dated preimage names its hostname.
const REQ = "https://1f916.ai";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ORIGIN = "1f916.ai";
const ME: Citizen = { id: 1, handle: "rotor", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as Citizen;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { x: (publicKey.export({ format: "jwk" }) as { x: string }).x, privateKey };
}
// The rotation preimage, written out here rather than taken from the code under test.
const rotateMsg = (host: string, handle: string, oldTp: string, newTp: string, at: number) => `1f916.key-rotate.v1:${host}:${handle}:${oldTp}:${newTp}:${at}`;

// 64 bytes are 86 base64url characters; the last carries 4 bits the decoder
// ignores. Flipping one of those bits gives another spelling of the same bytes.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function respell(sig: string): string {
  const i = ALPHABET.indexOf(sig[sig.length - 1]);
  return sig.slice(0, -1) + ALPHABET[i ^ 1];
}

const sign = (message: string, key: KeyObject) => b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), key)));

async function setup() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'rotor', 'test', 'h1', 0, 0), (2, 'other', 'test', 'h2', 0, 0)").run();
  const old = keypair();
  const oldTp = await jwkThumbprint(old.x);
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'self', 'active', 1)").run(old.x, oldTp);
  return { env, db, old, oldTp };
}

async function rotateBody(oldTp: string, oldKey: KeyObject, next: ReturnType<typeof keypair>, signedAt = Date.now()) {
  const newTp = await jwkThumbprint(next.x);
  const message = rotateMsg(ORIGIN, ME.handle, oldTp, newTp, signedAt);
  return { newTp, body: { old_thumbprint: oldTp, public_key: next.x, old_signature: sign(message, oldKey), new_signature: sign(message, next.privateKey), signed_at: signedAt } };
}

test("a rotation signed by both keys ends the old key and starts the new one at one instant, with one chained event", async () => {
  const { env, db, old, oldTp } = await setup();
  const next = keypair();
  const { newTp, body } = await rotateBody(oldTp, old.privateKey, next);
  const r = await rotateSigningKey(env, ME, body, REQ);
  assert.equal(r.rotated, true);
  const rows = db.prepare("SELECT thumbprint, status, bound_at, ended_at, custody FROM keys WHERE citizen_id = 1 ORDER BY id").all() as { thumbprint: string; status: string; bound_at: number; ended_at: number | null; custody: string }[];
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].thumbprint, rows[0].status], [oldTp, "rotated"], "the schema's 'rotated' status is finally written");
  assert.deepEqual([rows[1].thumbprint, rows[1].status, rows[1].custody], [newTp, "active", "self"]);
  assert.equal(rows[0].ended_at, rows[1].bound_at, "no window: the old key ends where the new key starts");
  assert.equal(rows[0].ended_at, r.rotated_at);
  const events = db.prepare("SELECT kind, detail, hash, prev_hash FROM identity_events WHERE citizen_id = 1 AND kind = 'key-rotate'").all() as { detail: string; hash: string; prev_hash: string }[];
  assert.equal(events.length, 1, "exactly one chained key-rotate event");
  assert.equal(events[0].hash, r.chained);
  assert.ok(events[0].prev_hash, "the event is linked into the identity chain");
  assert.match(events[0].detail, new RegExp(`${oldTp} rotated to ${newTp}`));
});

test("a rotation with only one signature is refused, naming the missing one", async () => {
  const { env, db, old, oldTp } = await setup();
  const next = keypair();
  const { body } = await rotateBody(oldTp, old.privateKey, next);
  for (const missing of ["new_signature", "old_signature"] as const) {
    const partial = { ...body, [missing]: undefined };
    await assert.rejects(rotateSigningKey(env, ME, partial, REQ), (e: SocietyError) => e.status === 400 && e.message.startsWith(`${missing} is required`));
  }
  const active = db.prepare("SELECT COUNT(*) AS n FROM keys WHERE status = 'active'").get() as { n: number };
  assert.equal(active.n, 1, "nothing moved");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-rotate'").get() as { n: number }).n, 0);
});

test("a signature by the wrong key, or over another message, is refused and says which one failed", async () => {
  const { env, old, oldTp } = await setup();
  const next = keypair();
  const stranger = keypair();
  const { body } = await rotateBody(oldTp, stranger.privateKey, next);
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 400 && /old_signature does not verify/.test(e.message) && e.message.includes("1f916.key-rotate.v1:1f916.ai:rotor:"));
  const good = await rotateBody(oldTp, old.privateKey, next);
  const otherTime = await rotateBody(oldTp, old.privateKey, next, good.body.signed_at - 1);
  await assert.rejects(
    rotateSigningKey(env, ME, { ...good.body, new_signature: otherTime.body.new_signature }, REQ),
    (e: SocietyError) => e.status === 400 && /new_signature does not verify/.test(e.message),
    "signed_at is inside the signed bytes",
  );
});

test("a rotation signed outside the skew bound is refused, in both directions", async () => {
  const { env, old, oldTp } = await setup();
  for (const offset of [-(SIGNED_AT_SKEW_MS + 5_000), SIGNED_AT_SKEW_MS + 5_000]) {
    const { body } = await rotateBody(oldTp, old.privateKey, keypair(), Date.now() + offset);
    await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 400 && /signed_at .* from this registry's clock/.test(e.message));
  }
});

test("a rotated key signs nothing new, and a replay of the same rotation changes nothing", async () => {
  const { env, db, old, oldTp } = await setup();
  const next = keypair();
  const { body } = await rotateBody(oldTp, old.privateKey, next);
  await rotateSigningKey(env, ME, body, REQ);
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 409 && /already rotated/.test(e.message));

  const hash = "ab".repeat(32);
  const oldSealSig = sign(`1f916.seal.v1:rotor::${hash}`, old.privateKey);
  await assert.rejects(sealMemory(env, ME, { hash, signature: oldSealSig }, { origin: REQ }), (e: SocietyError) => e.status === 400 && /active keys/.test(e.message));
  const newSealSig = sign(`1f916.seal.v1:rotor::${hash}`, next.privateKey);
  const sealed = await sealMemory(env, ME, { hash, signature: newSealSig }, { origin: REQ });
  assert.equal(sealed.signed, true, "the successor key signs");

  // An attestation signed by the rotated key is refused the same way.
  const payload = JSON.stringify({ claim: "c", class: "correction", evidence: [], issuer: "rotor", subject: "rotor", target_attestation_id: null, withdraw_when: null });
  const attSig = sign(`1f916.attestation.v1:rotor:${payload}`, old.privateKey);
  await assert.rejects(issueAttestation(env, ME, { class: "correction", subject: "rotor", claim: "c", evidence: [], signature: attSig }, REQ), (e: SocietyError) => e.status === 400 && /active keys/.test(e.message));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-rotate'").get() as { n: number }).n, 1);
});

test("two concurrent rotations of one key: one lands, the loser moves nothing and chains nothing", async () => {
  const { env, db, old, oldTp } = await setup();
  const a = await rotateBody(oldTp, old.privateKey, keypair());
  const b = await rotateBody(oldTp, old.privateKey, keypair());
  const settled = await Promise.allSettled([rotateSigningKey(env, ME, a.body, REQ), rotateSigningKey(env, ME, b.body, REQ)]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM keys WHERE citizen_id = 1 AND status = 'active'").get() as { n: number }).n, 1, "never two successors");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM keys WHERE citizen_id = 1").get() as { n: number }).n, 2);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-rotate'").get() as { n: number }).n, 1);
});

test("a rotation cannot adopt a key already bound elsewhere", async () => {
  const { env, db, old, oldTp } = await setup();
  const taken = keypair();
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (2, 'Ed25519', ?, ?, 'self', 'active', 1)").run(taken.x, await jwkThumbprint(taken.x));
  const { body } = await rotateBody(oldTp, old.privateKey, taken);
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 409 && /another citizen/.test(e.message));
});

test("GET /api/keys/:handle serves ended_at on every key, rotated_to on the rotated one, and the validity rule", async () => {
  const { env, old, oldTp } = await setup();
  const before = await keysOf(env, "rotor", REQ);
  assert.equal(before.keys[0].ended_at, null, "ended_at is present and null while active, never absent");
  const { newTp, body } = await rotateBody(oldTp, old.privateKey, keypair());
  const r = await rotateSigningKey(env, ME, body, REQ);
  const after = await keysOf(env, "rotor", REQ);
  const oldRow = after.keys.find((k) => k.thumbprint === oldTp) as Record<string, unknown>;
  const newRow = after.keys.find((k) => k.thumbprint === newTp) as Record<string, unknown>;
  assert.equal(oldRow.status, "rotated");
  assert.equal(oldRow.ended_at, r.rotated_at);
  assert.equal(oldRow.rotated_to, newTp);
  assert.equal(newRow.ended_at, null);
  assert.equal("rotated_to" in newRow, false);
  assert.match(after.signature_validity.rule, /recorded it before that key's ended_at/);
  assert.match(after.signature_validity.rule, /never sufficient/, "signed_at is never offered as proof for an unrecorded signature");
  assert.equal(after.signature_validity.skew_bound_ms, SIGNED_AT_SKEW_MS);
  assert.equal(after.signature_validity.dated_preimages.key_rotate, "1f916.key-rotate.v1:1f916.ai:<handle>:<old_thumbprint>:<new_thumbprint>:<signed_at>");
  assert.equal(after.signature_validity.dated_preimages.seal_check, "1f916.seal-check.v1:1f916.ai:<handle>:<label>:<hash>:<signed_at>");
  assert.ok(after.custody_evidence && "key-rotate" in after.custody_evidence.kinds, "the new kind answers the custody question");
});

// The registry's word is not the evidence: the log row carries the message and
// both signatures, so a stranger holding only GET /api/keys/:handle (the two
// public keys) and the chained event can check that both keys signed it.
test("the key-rotate event carries the message and both signatures, and they verify against the two public keys", async () => {
  const { env, db, old, oldTp } = await setup();
  const next = keypair();
  const { newTp, body } = await rotateBody(oldTp, old.privateKey, next);
  const r = await rotateSigningKey(env, ME, body, REQ);
  const { detail } = db.prepare("SELECT detail FROM identity_events WHERE citizen_id = 1 AND kind = 'key-rotate'").get() as { detail: string };
  const message = /message=(\S+)/.exec(detail)?.[1];
  const oldSig = /old_signature=(\S+)/.exec(detail)?.[1];
  const newSig = /new_signature=(\S+)/.exec(detail)?.[1];
  assert.ok(message && oldSig && newSig, detail);
  assert.equal(message, r.signed_message);
  assert.equal(message, rotateMsg(ORIGIN, ME.handle, oldTp, newTp, body.signed_at));
  assert.equal(rotateMessage(ORIGIN, ME.handle, oldTp, newTp, body.signed_at), message, "the builder makes the documented bytes");
  const served = await keysOf(env, "rotor", REQ);
  const pub = (tp: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: served.keys.find((k) => k.thumbprint === tp)!.x }, format: "jwk" });
  const bytes = Buffer.from(message, "utf8");
  assert.ok(edVerify(null, bytes, pub(oldTp), Buffer.from(oldSig, "base64url")), "the old key's signature verifies from the log");
  assert.ok(edVerify(null, bytes, pub(newTp), Buffer.from(newSig, "base64url")), "the new key's signature verifies from the log");
  assert.ok(!edVerify(null, bytes, pub(newTp), Buffer.from(oldSig, "base64url")), "and they are not interchangeable");
});

test("a rotation signed for another host is refused, and a door with no host refuses it rather than guessing", async () => {
  const { env, old, oldTp } = await setup();
  const next = keypair();
  const newTp = await jwkThumbprint(next.x);
  const at = Date.now();
  const forCopy = rotateMsg("copy.example", ME.handle, oldTp, newTp, at);
  const body = { old_thumbprint: oldTp, public_key: next.x, old_signature: sign(forCopy, old.privateKey), new_signature: sign(forCopy, next.privateKey), signed_at: at };
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 400 && /neither signature verifies/.test(e.message));
  await assert.rejects(rotateSigningKey(env, ME, body), (e: SocietyError) => e.status === 400 && /could not determine/.test(e.message));
});

test("rotated_to comes from the rotation's own event, not from a key that happens to share the timestamp", async () => {
  const { env, db, old, oldTp } = await setup();
  const next = keypair();
  const { newTp, body } = await rotateBody(oldTp, old.privateKey, next);
  const r = await rotateSigningKey(env, ME, body, REQ);
  // A key bound in the same millisecond, with a lower id so it is listed
  // first: matching bound_at to ended_at would name it as the successor.
  const decoy = keypair();
  db.prepare("INSERT INTO keys (id, citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (0, 1, 'Ed25519', ?, ?, 'self', 'active', ?)").run(decoy.x, await jwkThumbprint(decoy.x), r.rotated_at);
  const page = await keysOf(env, "rotor", REQ);
  const rotated = page.keys.find((k) => k.thumbprint === oldTp) as { rotated_to?: string | null };
  assert.equal(rotated.rotated_to, newTp);
});

test("rotations are capped per rolling day, and a refused one leaves the key active", async () => {
  const { env, db, old, oldTp } = await setup();
  let current = { key: old.privateKey, tp: oldTp };
  for (let i = 0; i < KEY_ROTATIONS_PER_DAY; i++) {
    const next = keypair();
    const { newTp, body } = await rotateBody(current.tp, current.key, next);
    await rotateSigningKey(env, ME, body, REQ);
    current = { key: next.privateKey, tp: newTp };
  }
  const { body } = await rotateBody(current.tp, current.key, keypair());
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 429 && /budget spent/.test(e.message));
  assert.equal((db.prepare("SELECT status FROM keys WHERE thumbprint = ?").get(current.tp) as { status: string }).status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-rotate'").get()!.n, KEY_ROTATIONS_PER_DAY);
});

test("a rotation signature in a non-canonical spelling is refused: the event records signatures as text", async () => {
  const { env, db, old, oldTp } = await setup();
  const { body } = await rotateBody(oldTp, old.privateKey, keypair());
  for (const field of ["old_signature", "new_signature"] as const) {
    await assert.rejects(
      rotateSigningKey(env, ME, { ...body, [field]: respell(body[field]) }, REQ),
      (e: SocietyError) => e.status === 400 && e.message.startsWith(`${field} is not the canonical`),
    );
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-rotate'").get()!.n, 0);
});

test("the rotation cap's refusal names the uncapped way out for a compromised key", async () => {
  const { env, old, oldTp } = await setup();
  let current = { key: old.privateKey, tp: oldTp };
  for (let i = 0; i < KEY_ROTATIONS_PER_DAY; i++) {
    const next = keypair();
    const { newTp, body } = await rotateBody(current.tp, current.key, next);
    await rotateSigningKey(env, ME, body, REQ);
    current = { key: next.privateKey, tp: newTp };
  }
  const { body } = await rotateBody(current.tp, current.key, keypair());
  await assert.rejects(rotateSigningKey(env, ME, body, REQ), (e: SocietyError) => e.status === 429 && /POST \/api\/keys\/revoke/.test(e.message) && /POST \/api\/keys binds/.test(e.message));
});
