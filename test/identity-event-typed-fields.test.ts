// The recovery rows say WHICH key acted and HOW it proved standing in typed
// columns instead of inside an English sentence.
//
// Why this exists. The identity log types `kind` — a closed vocabulary — and
// writes every other fact into `detail`, which schemas/events.json types as a
// bare string with no enum and no pattern. The registry already computes the
// distinction it then flattens: POST /api/keys/revoke records the strong form
// or the weaker revoke-by-credential, and the winner ends up interpolated into
// prose. The recovery rows this branch adds were doing the same thing —
// `recovery 12 completed by ck0vbEaH…, secret reissued` — so a verifier asking
// "which key opened this recovery" had to parse a sentence.
//
// The constraint that shapes the fix: `detail` is inside the hash preimage
// (PAYLOAD in src/chain.ts), so promoting a fact OUT of it would invalidate
// every hash ever written. UNHASHED is the escape hatch built beside it for
// exactly this, and until now it had one entry (`ledger: ["tx", "source"]`).
//
// The three properties below are what make that hatch honest, and the third
// is the one that costs something.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { holdRecovery, openRecovery, recoveryChallenge, type Env } from "../src/society.ts";
import { b64urlEncode, jwkThumbprint, recoverMessage } from "../src/keys.ts";
import { GENESIS, entryHash, verifyRows, sha256Hex, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SECRET = "1f916_sk_" + "ef".repeat(32);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { x: jwk.x, privateKey };
}

const sign = (message: string, privateKey: ReturnType<typeof keypair>["privateKey"]) =>
  b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), privateKey)));

async function seed(db: DatabaseSync) {
  const id = 1731;
  const handle = "typed-fields";
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model, created_at, last_seen_at) VALUES (?, ?, ?, 'claude-opus-5', 1, 1)").run(
    id,
    handle,
    await sha256Hex(SECRET),
  );
  const { x, privateKey } = keypair();
  const thumbprint = await jwkThumbprint(x);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', 'active', 1)").run(id, x, thumbprint);
  return { id, handle, thumbprint, privateKey };
}

async function openWithKey(env: Env, who: Awaited<ReturnType<typeof seed>>) {
  const challenge = await recoveryChallenge(env, who.handle, "open");
  return openRecovery(env, {
    handle: who.handle,
    thumbprint: who.thumbprint,
    nonce: challenge.nonce,
    signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
  });
}

const logRows = (db: DatabaseSync) =>
  db
    .prepare("SELECT id, citizen_id, kind, detail, subject_thumbprint, proof_mode, created_at, prev_hash, hash FROM identity_events ORDER BY id ASC")
    .all() as (ChainRow & { kind: string; detail: string; subject_thumbprint: string | null; proof_mode: string | null })[];

// PROPERTY 1 — the columns are outside the digest, so no hash ever written moves.
//
// Asserted against entryHash directly rather than through a request, because
// this is the contract the whole change rests on: if setting these fields
// changed the hash, every row in the live log would stop verifying the day the
// migration ran.
test("subject_thumbprint and proof_mode are outside the hash preimage", async () => {
  const bare = { citizen_id: 4, kind: "recovery-completed", detail: "recovery 12 completed by ck0vbEaH, secret reissued", created_at: 1785900000000 };
  const typed = { ...bare, subject_thumbprint: "ck0vbEaH", proof_mode: "bound-key-signature" };

  assert.equal(await entryHash("identity_events", GENESIS, bare), await entryHash("identity_events", GENESIS, typed));

  // And a row that carries them still chains onto one that does not, which is
  // what an upgraded database actually looks like: null before, set after.
  const first = await entryHash("identity_events", GENESIS, bare);
  const second = await entryHash("identity_events", first, typed);
  assert.notEqual(first, second);
});

// PROPERTY 2 — the facts land in the columns, and `detail` keeps its bytes.
test("a recovery opened by a bound key and held by a stranger records both, typed", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);

  await openWithKey(env, who);
  await holdRecovery(env, { handle: who.handle, reason: "not-me" });

  const rows = logRows(db);
  const opened = rows.find((r) => r.kind === "recovery-opened")!;
  const held = rows.find((r) => r.kind === "recovery-held")!;

  assert.equal(opened.subject_thumbprint, who.thumbprint);
  assert.equal(opened.proof_mode, "bound-key-signature");

  // The hold is the one channel that asks for nothing, and the record says so
  // in a field rather than leaving a reader to infer it from the sentence.
  assert.equal(held.subject_thumbprint, who.thumbprint);
  assert.equal(held.proof_mode, "unauthenticated");

  // detail is unchanged in shape — the prose is not being replaced, it is
  // being made unnecessary to parse.
  assert.match(opened.detail, /^recovery opened by /);
  assert.match(held.detail, /^recovery \d+ held by an unauthenticated challenge/);

  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, true);
});

// PROPERTY 3 — the cost, stated rather than discovered later.
//
// UNHASHED means UNSEALED. These columns are not tamper-evident: editing one
// leaves the chain verifying, exactly as editing `ledger.tx` does. That is the
// price of not invalidating every prior hash, and a reader who treats
// proof_mode as sealed testimony is wrong. The sealed record of the same fact
// remains the sentence in `detail`; the column is for counting without a
// regular expression, not for proving.
test("editing a typed field leaves the chain verifying — these columns are unsealed, on purpose", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  await openWithKey(env, who);

  db.prepare("UPDATE identity_events SET proof_mode = 'bearer-secret' WHERE kind = 'recovery-opened'").run();

  const rows = logRows(db);
  assert.equal(rows.find((r) => r.kind === "recovery-opened")!.proof_mode, "bearer-secret");
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, true, "the chain cannot see this edit, which is what UNHASHED means");
});
