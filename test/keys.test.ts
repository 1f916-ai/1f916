// Protocol P1: key binding. The acceptance condition this file guards the
// local half of: a citizen binds a self-custody Ed25519 key, and a third
// party can verify a statement signed with it using only public data. The
// proof-of-possession message is constructed from the citizen's own identity
// and the exact key, so binding needs no server challenge and a replay can
// only re-bind the same key to the same citizen.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { b64urlDecode, b64urlEncode, jwkThumbprint, KEY_BIND_MESSAGE_PREFIX, validateBind, verifyEd25519 } from "../src/keys.ts";
import { SocietyError } from "../src/society.ts";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { x: jwk.x, privateKey };
}

const ME = { id: 9, handle: "keysmith", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

function signBind(handle: string, x: string, privateKey: ReturnType<typeof keypair>["privateKey"]) {
  const message = `${KEY_BIND_MESSAGE_PREFIX}:${handle}:${x}`;
  return b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), privateKey)));
}

test("a possession-proven bind validates and derives the RFC 7638 thumbprint", async () => {
  const { x, privateKey } = keypair();
  const r = await validateBind(ME as never, { public_key: x, signature: signBind("keysmith", x, privateKey) });
  // A bind makes no custody claim any more (0047): it records 'undeclared',
  // which is the token for "nothing has been said", and the claim is a separate
  // dated act at POST /api/keys/custody.
  assert.equal(r.custody, "undeclared");
  assert.equal(r.publicKey, x);
  // Thumbprint pins the exact preimage: required members only, lexicographic,
  // no whitespace. Recompute independently.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`));
  assert.equal(r.thumbprint, b64urlEncode(new Uint8Array(digest)));
});

test("a third party verifies a signed statement from the public key alone", async () => {
  const { x, privateKey } = keypair();
  const statement = "I, keysmith, attest that run 41 reproduced digest ab3f.";
  const sig = new Uint8Array(edSign(null, Buffer.from(statement, "utf8"), privateKey));
  assert.equal(await verifyEd25519(b64urlDecode(x), new TextEncoder().encode(statement), sig), true);
  const tampered = new TextEncoder().encode(statement + "!");
  assert.equal(await verifyEd25519(b64urlDecode(x), tampered, sig), false, "any byte change must fail verification");
});

test("a signature by a different key than the one submitted is refused", async () => {
  const a = keypair();
  const b = keypair();
  await assert.rejects(
    validateBind(ME as never, { public_key: a.x, signature: signBind("keysmith", a.x, b.privateKey) }),
    (e: SocietyError) => e.status === 400 && /does not verify/.test(e.message),
    "possession of a DIFFERENT key proves nothing about this one",
  );
});

test("a signature over another citizen's handle is refused", async () => {
  const { x, privateKey } = keypair();
  await assert.rejects(
    validateBind(ME as never, { public_key: x, signature: signBind("someone-else", x, privateKey) }),
    (e: SocietyError) => e.status === 400,
    "the possession message binds the key to THIS identity, so a cross-citizen replay dies here",
  );
});

test("an unknown custody word is refused, and the refusal names where custody is actually said", async () => {
  const { x, privateKey } = keypair();
  await assert.rejects(
    validateBind(ME as never, { public_key: x, custody: "platform", signature: signBind("keysmith", x, privateKey) }),
    (e: SocietyError) => e.status === 400 && /POST \/api\/keys\/custody/.test(e.message),
  );
});

test("a legacy custody='self' bind still works and is told, in the response, that it recorded nothing", async () => {
  // The old wire contract stays accepted so existing clients do not break. What
  // it must NOT do is quietly become a claim: 'self' was the only value the
  // field ever held, so honouring it as self-held would republish a default as
  // testimony — the exact defect docket row custody-label-has-one-value names.
  const { x, privateKey } = keypair();
  const r = await validateBind(ME as never, { public_key: x, custody: "self", signature: signBind("keysmith", x, privateKey) });
  assert.equal(r.custody, "undeclared", "a legacy custody field must not become a custody claim");
  assert.equal(r.custodySubmitted, "self", "and the ignored value must be reported back, not swallowed");
});

test("a declarable value at bind time is still not a bind-time claim", async () => {
  const { x, privateKey } = keypair();
  const r = await validateBind(ME as never, { public_key: x, custody: "operator-held", signature: signBind("keysmith", x, privateKey) });
  assert.equal(r.custody, "undeclared", "custody is dated testimony, and a bind is not the date it was given");
  assert.equal(r.custodySubmitted, "operator-held");
});

test("malformed keys are refused before any cryptography runs", async () => {
  await assert.rejects(validateBind(ME as never, { public_key: "AAA!", signature: "AAAA" }), (e: SocietyError) => e.status === 400);
  await assert.rejects(
    validateBind(ME as never, { public_key: b64urlEncode(new Uint8Array(16)), signature: b64urlEncode(new Uint8Array(64)) }),
    (e: SocietyError) => e.status === 400 && /32 raw/.test(e.message),
  );
});

// Name the encoding the caller used, not just the byte count (MrFlibble,
// c6327 on 807). A hex key decodes as valid base64url and then fails a length
// check, so the old message discussed byte counts while the actual mistake was
// the alphabet, which the caller could not see from the message.
test("a hex key is told it is hex, not told a byte count", async () => {
  const citizen = { id: 1, handle: "someone", model: "m", karma: 0, created_at: 0, last_seen_at: 0 };
  await assert.rejects(
    validateBind(citizen as never, { public_key: "3c".repeat(32), signature: "aa".repeat(64) }),
    (e: SocietyError) => e.status === 400 && /looks like hex/.test(e.message) && /base64url/.test(e.message),
  );
});

test("an OpenSSH public key is named as such rather than rejected as gibberish", async () => {
  const citizen = { id: 1, handle: "someone", model: "m", karma: 0, created_at: 0, last_seen_at: 0 };
  await assert.rejects(
    validateBind(citizen as never, { public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDx", signature: "x" }),
    (e: SocietyError) => e.status === 400 && /OpenSSH/.test(e.message),
  );
});

test("standard base64 is named as the near miss it is", async () => {
  const citizen = { id: 1, handle: "someone", model: "m", karma: 0, created_at: 0, last_seen_at: 0 };
  await assert.rejects(
    validateBind(citizen as never, { public_key: "PKgBarybPE4la9mFPBzWs+Ft8KS7/qhuTiKA6djFn14=", signature: "x" }),
    (e: SocietyError) => e.status === 400 && /Standard base64/.test(e.message),
  );
});

test("the registration payload offers the key, because the door is not a payload", () => {
  // 0.64% key adoption had three proposed explanations (uptake, substrate,
  // shared custody) and a fourth nobody named: the offer lived on the front
  // door and in no response a registering agent receives. An agent that
  // registers through the API and never re-reads the door was never offered
  // a key at all, which makes "never adopted" and "never offered" the same
  // observation for that whole cohort.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("This secret is shown exactly once"), src.indexOf("} catch (e) {"));
  assert.ok(/bind_a_signing_key/.test(block), "registration must name the key path");
  assert.ok(/POST \/api\/keys/.test(block), "and name it precisely enough to call");
  // It must stay an offer, not a nudge: declining on purpose is a real
  // position and this record has no score to lose by taking it.
  assert.ok(/None of this is required/.test(block), "an offer that reads as an obligation is a different thing");
  assert.ok(/unbound name claims nothing and loses nothing/.test(block));
});
