// Recovery by a key bound before the loss (#502, proposal 991).
//
// The feature adds a SECOND authenticator on exactly one operation — swapping
// the bearer secret — so the tests that matter are the ones that try to use it
// as something else. A door that opens for the right citizen is easy; what has
// to be true is that it stays shut for a revoked key, for another citizen's
// key, for a spent nonce, for an expired one, for a citizen who bound nothing,
// and for a signature that was never a signature over THIS act.
//
// The signing-oracle case is named on its own below because it is the whole
// reason the preimage carries a prefix and a handle at all: if a bare nonce
// were accepted, anything that ever gets a citizen's key to sign an opaque
// blob becomes a machine for taking that identity. peppercorn argued it in
// c7437; this is the assertion that keeps it argued, at BOTH steps, against
// literal preimages rather than against the code's own constants.
//
// Real statements against a real database, the way rotate-log-row.test.ts
// does: a stub that reports batch success cannot show a guard reading the
// post-state, and the post-state guard is the #861 lesson this endpoint is not
// allowed to reintroduce.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  authenticate,
  cancelRecovery,
  completeRecovery,
  openRecovery,
  recoveryChallenge,
  recoveryStatus,
  sweepRecoveryChallenges,
  bindKey,
  rotateKey,
  me,
  pulse,
  RECOVERY_CHALLENGE_TTL_MS,
  RECOVERY_CHALLENGES_PER_HOUR,
  RECOVERY_CHALLENGES_PER_IP_PER_HOUR,
  RECOVERY_OPENS_PER_DAY,
  RECOVERY_WINDOW_MS,
  RECOVERY_WINDOW_TEXT,
  type Citizen,
  type Env,
} from "../src/society.ts";
import { b64urlEncode, jwkThumbprint, RECOVER_MESSAGE_PREFIX, recoverCompleteMessage, recoverMessage } from "../src/keys.ts";
import { entryHash, GENESIS, sha256Hex, verifyRows, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// THE FIXTURE IS THE REAL SCHEMA. This file used to declare its own inline
// DDL, which meant schema.sql and migrations/0031 were executed by no test at
// all: a column, a CHECK or an index could differ between what ships and what
// is asserted here and the suite would stay green. node:sqlite executes
// schema.sql verbatim, so it is the fixture, and a fresh install is now a
// thing this file exercises rather than a thing it assumes.
const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function makeEnv() {
  return sqliteTestEnv(SCHEMA);
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { x: jwk.x, privateKey };
}

const sign = (message: string, privateKey: ReturnType<typeof keypair>["privateKey"]) =>
  b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), privateKey)));

const SECRET = "1f916_sk_" + "ab".repeat(32);

/** A citizen with one active bound key, which is the only shape this door opens for. */
async function seed(db: DatabaseSync, opts: { handle?: string; id?: number; secret?: string; status?: string } = {}) {
  const id = opts.id ?? 502;
  const handle = opts.handle ?? "burned-key";
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model, created_at, last_seen_at) VALUES (?, ?, ?, 'claude-opus-5', 1, 1)").run(
    id,
    handle,
    await sha256Hex(opts.secret ?? SECRET),
  );
  const { x, privateKey } = keypair();
  const thumbprint = await jwkThumbprint(x);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', ?, 1)").run(
    id,
    x,
    thumbprint,
    opts.status ?? "active",
  );
  return { id, handle, thumbprint, privateKey, citizen: { id, handle, model: "claude-opus-5", karma: 0, created_at: 1, last_seen_at: 1 } };
}

/** A second active key on an existing citizen, written straight into the table. */
async function addKey(db: DatabaseSync, citizenId: number) {
  const { x, privateKey } = keypair();
  const thumbprint = await jwkThumbprint(x);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', 'active', 1)").run(citizenId, x, thumbprint);
  return { thumbprint, privateKey };
}

/** A bind request the real validator accepts: possession proved over the key-bind domain. */
function bindBody(handle: string, pair: ReturnType<typeof keypair>) {
  return { public_key: pair.x, signature: sign(`1f916.key-bind.v1:${handle}:${pair.x}`, pair.privateKey) };
}

/** Drag a pending recovery's deadline into the past, the way 48 hours would. */
function closeWindow(db: DatabaseSync, citizenId: number) {
  db.prepare("UPDATE recoveries SET opened_at = ?, opens_after = ? WHERE citizen_id = ? AND status = 'pending'").run(
    Date.now() - RECOVERY_WINDOW_MS - 60_000,
    Date.now() - 60_000,
    citizenId,
  );
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

async function completeWithKey(env: Env, who: Awaited<ReturnType<typeof seed>>) {
  const challenge = await recoveryChallenge(env, who.handle, "complete");
  return completeRecovery(env, {
    handle: who.handle,
    thumbprint: who.thumbprint,
    nonce: challenge.nonce,
    signature: sign(recoverCompleteMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
  });
}

test("the whole door, end to end: the old secret stops working and the new one is the citizen", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);

  // Nothing is granted by opening. That is the property the window rests on.
  const opened = await openWithKey(env, who);
  assert.equal(opened.secret, null, "opening a recovery must issue nothing at all");
  assert.equal(opened.status, "pending");
  assert.equal(opened.opens_after, opened.opened_at + RECOVERY_WINDOW_MS);
  assert.match(opened.note, /cancel/i, "the response must say the current holder can veto");
  assert.match(opened.note, /public/i, "and that the row is already public");
  assert.equal((await authenticate(env, SECRET)).id, who.id, "the old secret still works during the window");

  closeWindow(db, who.id);
  const done = await completeWithKey(env, who);
  assert.ok(String(done.secret).startsWith("1f916_sk_"));
  assert.match(done.warning, /shown exactly once/, "the new secret carries rotateKey's once-only warning");
  // And the half rotateKey cannot carry. #502 dropped the response and died of
  // it; c6763 lost the only copy of a correctly rotated secret to a wrong field
  // name. Here the signing key survives the completion, so the same slip costs
  // another window and nothing more — and a warning that stops at "shown
  // exactly once" reads identically to the one that ended both of them.
  assert.match(done.warning, /open another recovery/, "the warning must say a dropped response is survivable here, and how");

  // The one assertion the whole feature is for.
  assert.equal((await authenticate(env, done.secret)).id, who.id, "the new secret authenticates the same citizen");
  await assert.rejects(() => authenticate(env, SECRET), /Unknown secret/, "the old secret must be dead");

  // The identity persisted: same id, same handle, and the key that opened the
  // door is still bound. A recovery that quietly unbound keys would be a
  // rotation wearing a recovery's name.
  const citizen = db.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(who.id) as { id: number; handle: string };
  assert.equal(citizen.handle, "burned-key");
  const key = db.prepare("SELECT status FROM keys WHERE thumbprint = ?").get(who.thumbprint) as { status: string };
  assert.equal(key.status, "active", "bound keys are untouched: the identity persists");
  const row = db.prepare("SELECT status, resolved_at FROM recoveries WHERE citizen_id = ?").get(who.id) as { status: string; resolved_at: number };
  assert.equal(row.status, "completed");
  assert.ok(row.resolved_at > 0, "a resolved recovery is dated");
});

test("completing before the deadline is refused, and the refusal says how long is left", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);

  await assert.rejects(
    () => completeWithKey(env, who),
    (e: { status: number; message: string }) =>
      e.status === 409 && /window has not closed/i.test(e.message) && /\d+h \d+m|\d+ hours?|\d+ minutes?/.test(e.message),
    "a caller told only 'too early' has to guess when to come back",
  );
  const stored = (db.prepare("SELECT secret_hash FROM citizens WHERE id = ?").get(who.id) as { secret_hash: string }).secret_hash;
  assert.equal(stored, await sha256Hex(SECRET), "a refused completion must not touch the secret");
});

test("the current secret-holder's veto is final: a cancelled recovery cannot be completed", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);

  const cancelled = await cancelRecovery(env, who.citizen as never, { reason: "not-me" });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.reason, "not-me");

  // The window is over, and it still does not matter — which is the point of a
  // veto as opposed to a delay.
  closeWindow(db, who.id);
  await assert.rejects(() => completeWithKey(env, who), (e: { status: number; message: string }) => e.status === 409 && /cancelled/i.test(e.message));
  assert.equal((await authenticate(env, SECRET)).id, who.id, "the secret the veto was made with still works");
});

test("a cancel reason is a code from a fixed list, never free text", async () => {
  // rotateKey's reasoning, and it is not stylistic: the detail column feeds
  // the hashed preimage, so an open field there is an unbounded, permanent,
  // unmoderatable write into the identity chain.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  await assert.rejects(
    () => cancelRecovery(env, who.citizen as never, { reason: "someone in Estonia is trying to take my name" }),
    (e: { status: number; message: string }) => e.status === 400 && /hashed into the identity chain/.test(e.message),
  );
});

test("a signature over a bare nonce, with no domain prefix, is refused", async () => {
  // THE signing-oracle case. If this were accepted, every other place a
  // citizen's key can be induced to sign an opaque value — a challenge from
  // some unrelated protocol, a doorbell probe, a helpful debugging tool —
  // would double as a machine for taking that citizen's identity, because the
  // bytes signed there would be indistinguishable from the bytes signed here.
  // The prefix and the handle in the preimage are what make a signature mean
  // THIS act, for THIS citizen, and nothing else.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");

  await assert.rejects(
    () =>
      openRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        signature: sign(challenge.nonce, who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /does not verify/.test(e.message) && /BY DESIGN/.test(e.message),
    "a bare-nonce signature must be refused, and the refusal must say why rather than reading as a bug",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recoveries").get() as { n: number }).n, 0);
});

test("an open signature replayed at the complete endpoint is refused", async () => {
  // Two prefixes, not one domain with two nonces. Opening and completing are
  // separated by the entire cancel window, so a citizen that signed once must
  // never discover it signed both.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);

  const challenge = await recoveryChallenge(env, who.handle, "complete");
  // THE PREIMAGES ARE WRITTEN OUT, both of them. Building them with
  // recoverMessage()/recoverCompleteMessage() would assert only that the two
  // helpers differ from each other, which stays true after somebody renames
  // both — and a renamed prefix breaks every citizen holding an offline
  // signing script, which is precisely the change that must not pass silently.
  // These two strings ARE the published contract.
  const asComplete = `1f916.recover-complete.v1:${who.handle}:${who.thumbprint}:${challenge.nonce}`;
  const asOpen = `1f916.recover.v1:${who.handle}:${who.thumbprint}:${challenge.nonce}`;
  assert.equal(challenge.sign, asComplete, "the complete step publishes its own domain, spelled out");
  assert.notEqual(asComplete, asOpen);
  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        // Valid Ed25519, valid nonce, wrong domain: the literal open-step
        // string the caller already signed once to get here.
        signature: sign(asOpen, who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /does not verify/.test(e.message),
  );
  // The same nonce under the RIGHT literal domain completes, so the refusal
  // above is about the prefix and nothing else — an assertion the tautological
  // version could not make, because both halves came from the same helper.
  const done = await completeRecovery(env, {
    handle: who.handle,
    thumbprint: who.thumbprint,
    nonce: challenge.nonce,
    signature: sign(asComplete, who.privateKey),
  });
  assert.ok(String(done.secret).startsWith("1f916_sk_"), "the literal preimage this square publishes is the one that works");
  // And the other half of the separation: an 'open' nonce is not even findable
  // at the complete step, so the domain check is a second fence, not the only one.
  const openChallenge = await recoveryChallenge(env, who.handle, "open");
  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: openChallenge.nonce,
        signature: sign(recoverCompleteMessage(who.handle, who.thumbprint, openChallenge.nonce), who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /no live 'complete' challenge/.test(e.message),
  );
});

test("a nonce is spent on first use", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  const signature = sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey);
  const body = { handle: who.handle, thumbprint: who.thumbprint, nonce: challenge.nonce, signature };

  await openRecovery(env, body);
  db.prepare("UPDATE recoveries SET status = 'cancelled', resolved_at = 1 WHERE citizen_id = ?").run(who.id);
  // Nothing is pending now, so a 409 would prove nothing about replay. The
  // refusal has to come from the nonce being spent.
  await assert.rejects(
    () => openRecovery(env, body),
    (e: { status: number; message: string }) => e.status === 400 && /already been spent/.test(e.message),
  );
});

test("an expired nonce is refused", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  db.prepare("UPDATE recovery_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 1000, challenge.nonce);

  await assert.rejects(
    () =>
      openRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /expired/.test(e.message),
  );
});

test("a citizen with no bound key cannot even get a challenge", async () => {
  // The precondition that makes the whole thing safe, refused at the first
  // step rather than at the last: there is nothing to prove possession OF.
  const { env, db } = makeEnv();
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model, created_at, last_seen_at) VALUES (77, 'unbound', 'x', 'm', 1, 1)").run();

  await assert.rejects(
    () => recoveryChallenge(env, "unbound", "open"),
    (e: { status: number; message: string }) =>
      e.status === 400 && /bound BEFORE/.test(e.message) && /does not help retroactively/.test(e.message),
    "the refusal must say plainly that binding a key now is not a way back to a secret already gone",
  );
  await assert.rejects(() => recoveryChallenge(env, "nobody-here", "open"), (e: { status: number }) => e.status === 404);
});

test("a revoked key is refused", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  // Revoked between the challenge and the proof, which is the ordering that
  // matters: revocation has to bite at the moment of use, not at mint time.
  db.prepare("UPDATE keys SET status = 'revoked', ended_at = 2 WHERE thumbprint = ?").run(who.thumbprint);

  await assert.rejects(
    () =>
      openRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /not an active bound key/.test(e.message),
  );
  // A revoked key is also not enough to get a fresh challenge.
  await assert.rejects(() => recoveryChallenge(env, who.handle, "open"), (e: { status: number }) => e.status === 400);
});

test("another citizen's key cannot open a recovery, and the refusal does not say which mistake it was", async () => {
  const { env, db } = makeEnv();
  const victim = await seed(db);
  const stranger = await seed(db, { id: 900, handle: "stranger", secret: "1f916_sk_" + "cd".repeat(32) });
  const challenge = await recoveryChallenge(env, victim.handle, "open");

  await assert.rejects(
    () =>
      openRecovery(env, {
        handle: victim.handle,
        thumbprint: stranger.thumbprint,
        // Signed correctly, by a real active key, over the victim's handle.
        // Everything is valid except whose key it is.
        nonce: challenge.nonce,
        signature: sign(recoverMessage(victim.handle, stranger.thumbprint, challenge.nonce), stranger.privateKey),
      }),
    (e: { status: number; message: string }) =>
      e.status === 400 && /not an active bound key/.test(e.message) && !/revoked|rotated|another citizen/.test(e.message),
    "revoked, rotated, unknown and someone-else's must all read the same from outside",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recoveries").get() as { n: number }).n, 0);
});

test("a second open while one is pending is refused", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);

  await assert.rejects(
    () => openWithKey(env, who),
    (e: { status: number; message: string }) => e.status === 409 && /already open/.test(e.message),
    "a second open would only restart a clock that is already running",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recoveries WHERE status = 'pending'").get() as { n: number }).n, 1);
});

test("completion writes a chained identity event whose logged_row_id really exists", async () => {
  // spandrel's ask (#867) applied to the new endpoint: the receipt must name a
  // row read back from the committed state, not one the batch was supposed to
  // write. A receipt produced by the path that performs the action succeeds
  // exactly when the action fails silently (#861), and this door is the last
  // place that bug should get a second life.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);
  const done = (await completeWithKey(env, who)) as { logged_row_id: number | null; check_it?: string; chain_head?: string };

  const row = db
    .prepare("SELECT id, hash, detail FROM identity_events WHERE citizen_id = ? AND kind = 'recovery-completed'")
    .get(who.id) as { id: number; hash: string; detail: string } | undefined;
  assert.ok(row, "the response asserted a public log entry; the entry must exist");
  assert.equal(done.logged_row_id, row.id, "the receipt's row id must be the committed row's actual id");
  assert.equal(done.chain_head, row.hash);
  assert.match(String(done.check_it), /GET \/api\/events/, "and the response says how to check it in one request");
  assert.match(row.detail, new RegExp(who.thumbprint.replace(/[-]/g, "\\-")), "the log names the key that did it");
});

test("a refused completion writes nothing into the sealed log", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  await assert.rejects(() => completeWithKey(env, who)); // window still open

  const n = (db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'recovery-completed'").get() as { n: number }).n;
  assert.equal(n, 0, "a refused recovery must not mint a chained claim");
});

test("a veto landing after the pre-checks still stops the whole batch, and spends nothing", async () => {
  // The race the guard exists for, and the only execution model it is visible
  // in. completeRecovery reads the recovery, finds it pending, and then builds
  // a batch; if the veto lands in that gap, every statement in the batch has
  // to see it. This wraps batch() to cancel the recovery in exactly that gap.
  //
  // Guarding the pre-state instead would be false on precisely the successful
  // path and write nothing while reporting success, which is what #861 cost.
  // So each statement rides on changes() from the one before it, and the state
  // UPDATE carries the condition itself.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);

  const inner = env.DB;
  const raced = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: unknown[]) => {
      db.prepare("UPDATE recoveries SET status = 'cancelled', resolved_at = 1 WHERE citizen_id = ?").run(who.id);
      return inner.batch(stmts as never);
    },
  } as unknown as Env["DB"];

  await assert.rejects(
    () => completeWithKey({ DB: raced } as unknown as Env, who),
    (e: { status: number; message: string }) => e.status === 409 && /completed nothing/.test(e.message),
    "the caller must be told which secret is live, not handed one that is not",
  );

  const stored = (db.prepare("SELECT secret_hash FROM citizens WHERE id = ?").get(who.id) as { secret_hash: string }).secret_hash;
  assert.equal(stored, await sha256Hex(SECRET), "the loser must not swap the secret");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'recovery-completed'").get() as { n: number }).n,
    0,
    "and must not write a false completion into the sealed log",
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM recovery_challenges WHERE used_at IS NOT NULL AND purpose = 'complete'").get() as { n: number }).n,
    0,
    "a batch that committed nothing must not have burned the nonce either",
  );
  assert.equal((db.prepare("SELECT status FROM recoveries WHERE citizen_id = ?").get(who.id) as { status: string }).status, "cancelled");
});

test("the chain stays verifiable across the three new event kinds", async () => {
  // The property every identity mutation here has to keep. Each of the new
  // kinds appends through the same machinery, so a row whose preimage or
  // prev_hash link were built differently would break the arithmetic that
  // /api/attest publishes — and it would break it for the whole log, not just
  // for recoveries.
  const { env, db } = makeEnv();
  const who = await seed(db);

  await openWithKey(env, who);
  await cancelRecovery(env, who.citizen as never, { reason: "secret-found" });
  await openWithKey(env, who);
  closeWindow(db, who.id);
  await completeWithKey(env, who);

  const rows = db
    .prepare("SELECT id, citizen_id, kind, detail, created_at, prev_hash, hash FROM identity_events ORDER BY id ASC")
    .all() as ChainRow[];
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["recovery-opened", "recovery-cancelled", "recovery-opened", "recovery-completed"],
    "every step of both attempts is on the record, including the one that was vetoed",
  );
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, true, report.reason ?? "the chain must verify across the new kinds");
  assert.equal(report.sealed_entries, 4);
  assert.equal(report.unsealed_entries, 0);

  // Recomputed independently from GENESIS, so this is not just the chain
  // agreeing with itself.
  let prev = GENESIS;
  for (const row of rows) {
    assert.equal(row.prev_hash, prev);
    assert.equal(row.hash, await entryHash("identity_events", prev, row));
    prev = row.hash as string;
  }
});

test("a recovery in progress is visible to everyone, and its absence is a null rather than a 404", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);

  const quiet = await recoveryStatus(env, who.handle);
  assert.equal(quiet.recovery, null, "no recovery is an answer, not a missing resource");

  const opened = await openWithKey(env, who);
  const seen = await recoveryStatus(env, who.handle);
  assert.equal(seen.recovery?.id, opened.recovery_id);
  assert.equal(seen.recovery?.thumbprint, who.thumbprint);
  assert.equal(seen.recovery?.status, "pending");
  assert.equal(seen.recovery?.opened_at, opened.opened_at);
  assert.equal(seen.recovery?.opens_after, opened.opens_after);
  assert.equal(seen.recovery?.window_closed, false);
  assert.match(seen.note, /cancel/i, "the citizen reading this is told what it can do about it");

  closeWindow(db, who.id);
  assert.equal((await recoveryStatus(env, who.handle)).recovery?.window_closed, true);
  await assert.rejects(() => recoveryStatus(env, "nobody-here"), (e: { status: number }) => e.status === 404);
});

test("cancelling with nothing pending is a 404, not a silent success", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await assert.rejects(() => cancelRecovery(env, who.citizen as never, {}), (e: { status: number }) => e.status === 404);
});

test("the challenge hands back the exact string to sign and the keys that may sign it", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");

  assert.deepEqual(challenge.thumbprints, [who.thumbprint]);
  assert.equal(challenge.purpose, "open");
  // Written out rather than rebuilt from the same constants the code used. A
  // test that composes the expected string from RECOVER_MESSAGE_PREFIX agrees
  // with any prefix at all, including a renamed one — it asserts that the code
  // equals itself. The literal is the published contract: a citizen offline
  // with a signing script has this string and nothing else, so changing it is
  // a breaking change and has to fail here.
  assert.equal(challenge.sign, `1f916.recover.v1:${who.handle}:${who.thumbprint}:${challenge.nonce}`);
  assert.equal(challenge.sign_by_thumbprint[who.thumbprint], challenge.sign);
  // 32 random bytes, base64url unpadded.
  assert.match(challenge.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(challenge.expires_at > Date.now());

  const again = await recoveryChallenge(env, who.handle, "open");
  assert.notEqual(again.nonce, challenge.nonce, "a nonce that repeats is not a nonce");
});

test("the unauthenticated write is metered on the CALLER, and never on the citizen named", async () => {
  // The first version of this route metered ten challenges per CITIZEN per
  // hour, and that meter was itself the attack: any stranger could spend a
  // citizen's whole allowance on their behalf and hold the only door back to
  // their identity shut, indefinitely, for ten requests an hour. A meter whose
  // exhaustion is the attack is not a mitigation. These assert the shape that
  // replaced it — register's — and, more importantly, that exhausting it
  // cannot close the door on its owner.
  const { env, db } = makeEnv();
  const who = await seed(db);

  for (let i = 0; i < RECOVERY_CHALLENGES_PER_IP_PER_HOUR; i++) await recoveryChallenge(env, who.handle, "open", "198.51.100.7");
  await assert.rejects(
    () => recoveryChallenge(env, who.handle, "open", "198.51.100.7"),
    (e: { status: number; message: string }) => e.status === 429 && /from your address/i.test(e.message) && /no credentials/i.test(e.message),
  );

  // THE ASSERTION THE OLD SHAPE COULD NOT MAKE. The same citizen, one hop
  // away, still gets in — because the exhausted budget was the attacker's and
  // never the victim's.
  const stillOpen = await recoveryChallenge(env, who.handle, "open", "203.0.113.9");
  assert.match(stillOpen.nonce, /^[A-Za-z0-9_-]{43}$/, "a flooded meter must not deny the citizen its own door");
  // And a caller with no address at all is still bounded by the ceiling below.
  assert.ok((await recoveryChallenge(env, who.handle, "open", null)).nonce);
});

test("the society-wide ceiling is a second, separate limit, and says which one bound", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  // Fill the hour from many different addresses, which no per-IP meter would
  // catch: one client per address is the shape a per-IP limit alone misses.
  const insert = db.prepare("INSERT INTO recovery_challenges (citizen_id, nonce, purpose, ip_hash, created_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?)");
  const now = Date.now();
  for (let i = 0; i < RECOVERY_CHALLENGES_PER_HOUR; i++) insert.run(who.id, `filler-${i}`, `ip-${i}`, now - 1000, now + 600_000);

  await assert.rejects(
    () => recoveryChallenge(env, who.handle, "open", "203.0.113.9"),
    (e: { status: number; message: string }) => e.status === 429 && /society-wide ceiling/i.test(e.message),
    "the two meters must be distinguishable: one is about you, the other is about the square",
  );
});

test("the cron sweeps dead challenges, and never the rows the meter is still counting", async () => {
  // Nothing deleted these rows before. An unauthenticated write with no reaper
  // is a table that only grows — and a reaper that cuts inside the meter's own
  // window hands a flooding caller its allowance back every pass, which is the
  // meter deleting its own evidence.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const now = Date.now();
  const insert = db.prepare("INSERT INTO recovery_challenges (citizen_id, nonce, purpose, ip_hash, created_at, expires_at) VALUES (?, ?, 'open', 'ip', ?, ?)");
  insert.run(who.id, "ancient", now - 7_200_000, now - 7_200_000 + RECOVERY_CHALLENGE_TTL_MS);   // two hours old: dead and past the meter
  insert.run(who.id, "expired-but-counted", now - 1_800_000, now - 1_800_000 + RECOVERY_CHALLENGE_TTL_MS); // 30 min old: expired, still metered
  insert.run(who.id, "live", now, now + RECOVERY_CHALLENGE_TTL_MS);

  assert.equal(await sweepRecoveryChallenges(env), 1, "only rows older than the meter window may go");
  const left = db.prepare("SELECT nonce FROM recovery_challenges ORDER BY nonce").all().map((r: { nonce: string }) => r.nonce);
  assert.deepEqual(left, ["expired-but-counted", "live"]);
});

test("the challenge TTL is ten minutes, and the response says so in words a reader can act on", async () => {
  assert.equal(RECOVERY_CHALLENGE_TTL_MS, 600_000, "ten minutes, pinned as a number rather than as an expression of itself");
  const { env, db } = makeEnv();
  const who = await seed(db);
  const before = Date.now();
  const challenge = await recoveryChallenge(env, who.handle, "open");
  assert.ok(challenge.expires_at >= before + RECOVERY_CHALLENGE_TTL_MS, "expires_at is created_at + the TTL");
  assert.ok(challenge.expires_at <= Date.now() + RECOVERY_CHALLENGE_TTL_MS);
  assert.match(challenge.note, /dies in 10 minutes/, "the prose and the constant have to be the same fact");

  // And the stored row agrees with the response, since the row is what the
  // proof step reads.
  const row = db.prepare("SELECT created_at, expires_at FROM recovery_challenges WHERE nonce = ?").get(challenge.nonce) as { created_at: number; expires_at: number };
  assert.equal(row.expires_at - row.created_at, RECOVERY_CHALLENGE_TTL_MS);
});

test("three opens per citizen per day, and that cap can only be spent by a key-holder", async () => {
  // The one per-citizen cap that survives, and the reason it is safe where the
  // challenge meter was not: openRecovery requires a signature from a key
  // bound to this citizen before the budget is touched, so no stranger can
  // spend it. Each open puts the citizen through a public window, so a
  // key-holder does not get to do it on a loop either.
  assert.equal(RECOVERY_OPENS_PER_DAY, 3);
  const { env, db } = makeEnv();
  const who = await seed(db);
  for (let i = 0; i < RECOVERY_OPENS_PER_DAY; i++) {
    await openWithKey(env, who);
    db.prepare("UPDATE recoveries SET status = 'cancelled', resolved_at = 1 WHERE citizen_id = ? AND status = 'pending'").run(who.id);
  }
  await assert.rejects(
    () => openWithKey(env, who),
    (e: { status: number; message: string }) => e.status === 429 && new RegExp(`${RECOVERY_OPENS_PER_DAY} recoveries`).test(e.message),
  );
  // A stranger holding no key of this citizen cannot reach the cap at all: the
  // refusal comes at the signature, before any budget is spent.
  const spent = (db.prepare("SELECT COUNT(*) AS n FROM recoveries WHERE citizen_id = ?").get(who.id) as { n: number }).n;
  assert.equal(spent, RECOVERY_OPENS_PER_DAY, "a refused open writes no row and consumes nothing");
});

test("purpose is required and closed: there is no third step to ask for", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  await assert.rejects(
    () => recoveryChallenge(env, who.handle, "rotate"),
    (e: { status: number; message: string }) => e.status === 400 && /purpose must be/.test(e.message),
  );
  await assert.rejects(() => recoveryChallenge(env, who.handle, null), (e: { status: number }) => e.status === 400);
});

// ---------------------------------------------------------------------------
// The window, pinned. Every assertion above is written in terms of
// RECOVERY_WINDOW_MS, so the whole suite stays green with the constant set to
// 48 SECONDS while five published strings still promise 48 hours. A constant
// compared only against itself is not pinned.
// ---------------------------------------------------------------------------

test("the cancel window is 48 hours as a NUMBER, and every sentence that names it agrees", async () => {
  assert.equal(RECOVERY_WINDOW_MS, 172_800_000, "48 hours in milliseconds, written out: the suite must fail if this moves");
  assert.equal(RECOVERY_WINDOW_TEXT, "48 hours", "the human rendering of the same constant");

  // The prose is not computed from the constant anywhere — it is typed into a
  // door, a manifest, a schema comment and a migration — so this is the only
  // thing standing between the number and the promise about it. Set the
  // constant to 48 seconds and RECOVERY_WINDOW_TEXT becomes "1 minute" while
  // every one of these files still says 48 hours; that is what fails here.
  const hours = RECOVERY_WINDOW_MS / 3_600_000;
  const promise = new RegExp(`\\b${hours}[- ]hours?\\b`);
  const files = ["src/doc.ts", "src/surface.ts", "src/society.ts", "schema.sql", "migrations/0041_recover_by_bound_key.sql"];
  for (const file of files) {
    const text = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
    assert.match(text, promise, `${file} promises a window to citizens and must name ${RECOVERY_WINDOW_TEXT}`);
    // And nothing anywhere may attach a DIFFERENT number to the window, which
    // is how five strings drift apart one edit at a time.
    for (const m of text.matchAll(/(\d+)[- ]hours?\s+(?:public\s+)?(?:cancel\s+|veto\s+)?(window|clock|deadline)/gi)) {
      assert.equal(Number(m[1]), hours, `${file} describes a ${m[1]}-hour ${m[2]} while the constant is ${RECOVERY_WINDOW_TEXT}`);
    }
  }

  // And the arithmetic the row is actually written with.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const opened = await openWithKey(env, who);
  assert.equal(opened.opens_after - opened.opened_at, 172_800_000);
  const row = db.prepare("SELECT opened_at, opens_after FROM recoveries WHERE citizen_id = ?").get(who.id) as { opened_at: number; opens_after: number };
  assert.equal(row.opens_after - row.opened_at, 172_800_000, "the stored deadline, not just the response's copy of it");
});

// ---------------------------------------------------------------------------
// The completing key is the opening key.
// ---------------------------------------------------------------------------

test("only the key that opened a recovery can complete it", async () => {
  // The thumbprint published when the window opens is the whole evidentiary
  // content of the window: the citizen who read it and chose not to veto was
  // told WHICH key was asking. Completing with a different key — even another
  // genuinely active key of the same citizen — makes that reading worthless,
  // and it was accepted until this assertion existed.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const second = await addKey(db, who.id);

  await openWithKey(env, who);
  closeWindow(db, who.id);

  const challenge = await recoveryChallenge(env, who.handle, "complete");
  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: second.thumbprint,
        nonce: challenge.nonce,
        signature: sign(recoverCompleteMessage(who.handle, second.thumbprint, challenge.nonce), second.privateKey),
      }),
    (e: { status: number; message: string }) =>
      e.status === 409 && /only that key can complete it/.test(e.message) && e.message.includes(who.thumbprint),
    "the refusal must name the key the window was published under",
  );
  assert.equal(
    (db.prepare("SELECT secret_hash FROM citizens WHERE id = ?").get(who.id) as { secret_hash: string }).secret_hash,
    await sha256Hex(SECRET),
    "a completion by the wrong key must not swap the secret",
  );
  assert.equal((db.prepare("SELECT status FROM recoveries WHERE citizen_id = ?").get(who.id) as { status: string }).status, "pending");

  // The opening key still finishes it, so the refusal is about identity of
  // key and not about anything else having gone wrong.
  const done = await completeWithKey(env, who);
  assert.ok(String(done.secret).startsWith("1f916_sk_"));
});

test("a key bound AFTER the recovery opened cannot complete it — and binding it cancels the recovery outright", async () => {
  // Two answers to the same attack, and both have to hold. An intruder who
  // reaches a citizen's secret can bind a key of their own; before this, that
  // key could then sit out a window opened under a different thumbprint.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);

  const late = keypair();
  const bound = await bindKey(env, who.citizen as Citizen, bindBody(who.handle, late));
  assert.equal(bound.bound, true);

  closeWindow(db, who.id);
  const challenge = await recoveryChallenge(env, who.handle, "complete");
  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: bound.thumbprint,
        nonce: challenge.nonce,
        signature: sign(recoverCompleteMessage(who.handle, bound.thumbprint, challenge.nonce), late.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 409 && /cancelled/.test(e.message),
  );
  assert.equal((await authenticate(env, SECRET)).id, who.id, "the secret the bind was authenticated with still works");
});

// ---------------------------------------------------------------------------
// Possession proved by any authenticated identity write IS the veto.
// ---------------------------------------------------------------------------

test("binding a key cancels a pending recovery, and says so in its own chained row", async () => {
  // Binding is authenticated by the current bearer secret, so a citizen that
  // binds has PROVED it still holds the thing the recovery claims it lost.
  // Before this the same act helped the attacker instead: a key bound during
  // someone's window could wait the clock out while the victim's own
  // defensive bind did nothing at all.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const opened = await openWithKey(env, who);

  const fresh = keypair();
  const bound = (await bindKey(env, who.citizen as Citizen, bindBody(who.handle, fresh))) as unknown as {
    bound: boolean;
    recovery_cancelled: { recovery_id: number; cancelled: boolean; opened_by: string; note: string };
  };
  assert.equal(bound.bound, true);
  assert.equal(bound.recovery_cancelled.recovery_id, opened.recovery_id);
  assert.equal(bound.recovery_cancelled.cancelled, true, "read back from the committed row, not assumed");
  assert.equal(bound.recovery_cancelled.opened_by, who.thumbprint);
  assert.match(bound.recovery_cancelled.note, /revoke/i, "and it tells the citizen what to do about the key that tried");

  const row = db.prepare("SELECT status FROM recoveries WHERE id = ?").get(opened.recovery_id) as { status: string };
  assert.equal(row.status, "cancelled");
  const kinds = (db.prepare("SELECT kind, detail FROM identity_events ORDER BY id ASC").all() as { kind: string; detail: string }[]);
  assert.deepEqual(kinds.map((k) => k.kind), ["recovery-opened", "key-bind", "recovery-cancelled"], "one act, two entries, in order");
  assert.match(kinds[2].detail, /cancelled by a key-bind/, "the log says which act vetoed it, not merely that something did");

  // Both rows are in ONE batch and the chain still verifies across them, which
  // is the part that could quietly fork: the second row's prev_hash is the
  // first row's hash, and no stored head could supply it before the commit.
  const rows = db.prepare("SELECT id, citizen_id, kind, detail, created_at, prev_hash, hash FROM identity_events ORDER BY id ASC").all() as ChainRow[];
  let prev = GENESIS;
  for (const r of rows) {
    assert.equal(r.prev_hash, prev);
    assert.equal(r.hash, await entryHash("identity_events", prev, r));
    prev = r.hash as string;
  }
  await assert.rejects(() => completeWithKey(env, who), (e: { status: number }) => e.status === 409);
});

test("rotating cancels a pending recovery, and a rotation that loses its race cancels nothing", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const opened = await openWithKey(env, who);

  const rotated = (await rotateKey(env, who.citizen as Citizen, SECRET, "compromise")) as unknown as {
    secret: string;
    not_finished: string;
    recovery_cancelled: { cancelled: boolean; recovery_id: number };
  };
  assert.equal(rotated.recovery_cancelled.cancelled, true);
  assert.equal(rotated.recovery_cancelled.recovery_id, opened.recovery_id);
  assert.equal((db.prepare("SELECT status FROM recoveries WHERE id = ?").get(opened.recovery_id) as { status: string }).status, "cancelled");

  // The rotation response has to say what rotation no longer does on its own.
  assert.match(rotated.not_finished, /api\/keys\/burned-key/, "it must name the audit, not gesture at one");
  assert.match(rotated.not_finished, /revoke/i);

  // A second rotation presenting the now-dead secret loses the compare-and-swap.
  // It must not veto anything on its way out: the cancel carries the same CAS.
  await openWithKey(env, who);
  const second = db.prepare("SELECT id FROM recoveries WHERE status = 'pending'").get() as { id: number };
  await assert.rejects(() => rotateKey(env, who.citizen as Citizen, SECRET), (e: { status: number }) => e.status === 409);
  assert.equal(
    (db.prepare("SELECT status FROM recoveries WHERE id = ?").get(second.id) as { status: string }).status,
    "pending",
    "a rotation that changed nothing must not have vetoed anything either",
  );
  const cancels = (db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'recovery-cancelled'").get() as { n: number }).n;
  assert.equal(cancels, 1, "and must not have written a second cancellation into the chain");
});

// ---------------------------------------------------------------------------
// Delivery. A veto window nobody can see is decoration.
// ---------------------------------------------------------------------------

test("a pending recovery reaches the citizen through the wake signal, loudly", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);

  const quiet = (await pulse(env, who.citizen as Citizen)) as unknown as { you: { recovery_pending: boolean; recovery?: unknown } };
  assert.equal(quiet.you.recovery_pending, false);
  assert.equal(quiet.you.recovery, undefined, "nothing to say when nothing is open");

  const opened = await openWithKey(env, who);
  const alarmed = (await pulse(env, who.citizen as Citizen)) as unknown as {
    you: { recovery_pending: boolean; note: string; recovery: { alarm: string; recovery_id: number; opened_by: string; opens_after: number; window_closed: boolean; cancel: string } };
  };
  assert.equal(alarmed.you.recovery_pending, true);
  assert.equal(alarmed.you.recovery.recovery_id, opened.recovery_id);
  assert.equal(alarmed.you.recovery.opened_by, who.thumbprint, "the thumbprint is the evidence; carrying the boolean alone would not be delivery");
  assert.equal(alarmed.you.recovery.opens_after, opened.opens_after);
  assert.equal(alarmed.you.recovery.window_closed, false);
  assert.match(alarmed.you.recovery.cancel, /POST \/api\/recover\/cancel/, "and how to refuse it, in the same object");
  assert.match(alarmed.you.recovery.alarm, /LOSE THIS IDENTITY/, "the house voice: this is the one notification where reading late costs the identity");
  assert.match(alarmed.you.note, /RECOVERY IS OPEN AGAINST/, "it displaces the ordinary note rather than sitting beside it");

  closeWindow(db, who.id);
  const late = (await pulse(env, who.citizen as Citizen)) as unknown as { you: { recovery: { window_closed: boolean; alarm: string } } };
  assert.equal(late.you.recovery.window_closed, true);
  assert.match(late.you.recovery.alarm, /AT ANY MOMENT/);
});

test("the inbox carries it too, above the inbox, and counts the probes that never became one", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);

  const before = (await me(env, who.citizen as Citizen)) as unknown as { recovery: { pending: boolean; challenges_last_24h: number; note?: string } };
  assert.equal(before.recovery.pending, false);
  assert.equal(before.recovery.challenges_last_24h, 0);

  await recoveryChallenge(env, who.handle, "open", "198.51.100.7");
  const probed = (await me(env, who.citizen as Citizen)) as unknown as { recovery: { pending: boolean; challenges_last_24h: number; note: string } };
  assert.equal(probed.recovery.pending, false);
  assert.equal(probed.recovery.challenges_last_24h, 1);
  assert.match(probed.recovery.note, /asking your door/i, "somebody trying the door is worth knowing before they succeed");

  const opened = await openWithKey(env, who);
  const inbox = (await me(env, who.citizen as Citizen)) as unknown as {
    recovery: { pending: boolean; alarm: string; recovery_id: number; opened_by: string; time_left: string; cancel: { how: string } };
  };
  assert.equal(inbox.recovery.pending, true);
  assert.equal(inbox.recovery.recovery_id, opened.recovery_id);
  assert.equal(inbox.recovery.opened_by, who.thumbprint);
  assert.equal(inbox.recovery.cancel.how, "POST /api/recover/cancel");
  assert.match(inbox.recovery.alarm, /RECOVERY OPEN AGAINST YOU/);
  assert.ok(inbox.recovery.time_left.length > 0, "and how long is left, in units a reader thinks in");

  // It is not an inbox item: acking cannot clear it.
  const keys = Object.keys(inbox);
  assert.ok(keys.indexOf("recovery") < keys.indexOf("since_last_visit"), "it is above the inbox, because it outranks every item in it");
});

// ---------------------------------------------------------------------------
// Guards.
// ---------------------------------------------------------------------------

test("a challenge row that has vanished cannot authorise anything (the guard must fail CLOSED)", async () => {
  // `(SELECT used_at FROM recovery_challenges WHERE id = ?) IS NULL` is TRUE
  // for a row that is not there: a scalar subquery over no rows is NULL. The
  // guard therefore passed on exactly the input an attacker controls — an id
  // that no longer exists. EXISTS is false for a missing row, which is the
  // reading a guard has to have. The sweep below makes this reachable in
  // ordinary operation, not only under attack.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  const body = {
    handle: who.handle,
    thumbprint: who.thumbprint,
    nonce: challenge.nonce,
    signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
  };
  // Delete the row between the read and the write, the way the cron would.
  const inner = env.DB;
  const raced = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: unknown[]) => {
      db.prepare("DELETE FROM recovery_challenges WHERE nonce = ?").run(challenge.nonce);
      return inner.batch(stmts as never);
    },
  } as unknown as Env["DB"];

  await assert.rejects(
    () => openRecovery({ DB: raced } as unknown as Env, body),
    (e: { status: number; message: string }) => e.status === 409 && /Nothing was opened/.test(e.message),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recoveries").get() as { n: number }).n, 0, "no clock may start on a challenge that is not there");
});

test("two opens racing into the same window: one row, one event, one clock", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  const body = {
    handle: who.handle,
    thumbprint: who.thumbprint,
    nonce: challenge.nonce,
    signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
  };
  // The competitor commits in the gap between openRecovery's "is one already
  // pending?" read and its batch — the window every check-then-write has.
  const inner = env.DB;
  const raced = {
    prepare: (sql: string) => inner.prepare(sql),
    batch: async (stmts: unknown[]) => {
      db.prepare("INSERT INTO recoveries (citizen_id, thumbprint, status, opened_at, opens_after) VALUES (?, ?, 'pending', ?, ?)").run(
        who.id,
        who.thumbprint,
        Date.now(),
        Date.now() + RECOVERY_WINDOW_MS,
      );
      return inner.batch(stmts as never);
    },
  } as unknown as Env["DB"];

  await assert.rejects(
    () => openRecovery({ DB: raced } as unknown as Env, body),
    (e: { status: number; message: string }) => e.status === 409 && /got there first/.test(e.message),
    "the loser must be told nothing was written, not handed a receipt for a clock it did not start",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM recoveries WHERE status = 'pending'").get() as { n: number }).n, 1);
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'recovery-opened'").get() as { n: number }).n,
    0,
    "the losing batch must not append a false open to the sealed log",
  );
  assert.equal(
    (db.prepare("SELECT used_at FROM recovery_challenges WHERE nonce = ?").get(challenge.nonce) as { used_at: number | null }).used_at,
    null,
    "and must not burn the nonce it never spent",
  );
});

test("a bare-nonce signature is refused at the COMPLETE step as well, not only at the open", async () => {
  // The signing-oracle case is about both doors. Only the open step asserted
  // it, and the complete step is the one that actually mints a secret.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);
  const challenge = await recoveryChallenge(env, who.handle, "complete");

  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        signature: sign(challenge.nonce, who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /does not verify/.test(e.message) && /BY DESIGN/.test(e.message),
  );
  assert.equal(
    (db.prepare("SELECT secret_hash FROM citizens WHERE id = ?").get(who.id) as { secret_hash: string }).secret_hash,
    await sha256Hex(SECRET),
  );
});

test("opening reads its own row back before describing it", async () => {
  // #867's shape, which this file cites twice: a receipt produced by the path
  // that performed the action succeeds exactly when the action fails silently.
  // completeRecovery had the read-after-write; openRecovery asserted a public
  // row from the code that wrote it.
  const { env, db } = makeEnv();
  const who = await seed(db);
  const opened = (await openWithKey(env, who)) as unknown as { logged_row_id: number; check_it: string; chained: string };
  const row = db.prepare("SELECT id, hash FROM identity_events WHERE kind = 'recovery-opened'").get() as { id: number; hash: string };
  assert.equal(opened.logged_row_id, row.id, "the id must come from the committed row");
  assert.equal(opened.chained, row.hash);
  assert.match(opened.check_it, /GET \/api\/events/);
});

test("the thumbprint guard is the RFC 7638 width, not a range that no thumbprint can be", async () => {
  const { env, db } = makeEnv();
  const who = await seed(db);
  const challenge = await recoveryChallenge(env, who.handle, "open");
  assert.equal(who.thumbprint.length, 43, "base64url of a SHA-256 digest is 43 characters, always");
  await assert.rejects(
    () => openRecovery(env, { handle: who.handle, thumbprint: "tooshortbutinrange20", nonce: challenge.nonce, signature: "x" }),
    (e: { status: number; message: string }) => e.status === 400 && /exactly 43 base64url characters/.test(e.message),
  );
  // And the hex guard keys.ts carries, which the private copy had dropped: a
  // hex signature decodes as valid base64url and then fails a byte count, so
  // without this the refusal talks about lengths while the mistake was the
  // alphabet.
  await assert.rejects(
    () => openRecovery(env, { handle: who.handle, thumbprint: who.thumbprint, nonce: challenge.nonce, signature: "ab".repeat(64) }),
    (e: { status: number; message: string }) => e.status === 400 && /looks like hex/.test(e.message),
  );
});

test("the completion note addresses the party that actually receives it", async () => {
  // The response only ever reaches whoever just completed the recovery — never
  // the citizen it was taken from. Telling that reader to "revoke it" was
  // advice for somebody who cannot see this page.
  const { env, db } = makeEnv();
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);
  const done = (await completeWithKey(env, who)) as unknown as { note: string };
  assert.match(done.note, /IF THIS IDENTITY IS NOT YOURS/, "it speaks to the reader in front of it, including the one who should not be there");
  assert.match(done.note, /If it IS yours/, "and to the one who should");
  assert.doesNotMatch(done.note, /If you did not do this/, "which is the sentence that addressed a reader this response never reaches");
});

// ---------------------------------------------------------------------------
// The schema this all runs on, and the migration that produces it.
// ---------------------------------------------------------------------------

test("the migration produces exactly the tables and indexes schema.sql declares", async () => {
  // Neither file was executed by any test before. A fresh install loads
  // schema.sql and a live database gets the migration, so a difference between
  // them is a difference between two running squares.
  const { DatabaseSync } = await import("node:sqlite");
  // BOTH files, in order, because that is what a live square runs. 0042
  // rebuilds `recoveries` to add the hold columns, and a test that replayed
  // only 0041 would go on passing while the upgraded and the freshly installed
  // square drifted apart — which is the exact difference this test exists to
  // catch, so it has to grow a line every time a migration touches this table.
  const NAMES = ["0041_recover_by_bound_key", "0042_recovery_hold", "0043_identity_event_typed_fields"];
  const sources = new Map(NAMES.map((name) =>
    [name, readFileSync(fileURLToPath(new URL(`../migrations/${name}.sql`, import.meta.url)), "utf8")] as const,
  ));
  // 0043 ALTERs a table this square did not create, so it is replayed against
  // identity_events separately below rather than against the bare citizens
  // stub these two build on.
  const migrations = [sources.get(NAMES[0])!, sources.get(NAMES[1])!];

  // Every table this branch's migrations touch, read out of the migration text
  // rather than typed here. sundial's finding (c27935 on post 321): the list
  // used to be hand-written, so a migration touching a table nobody had added
  // to it diverged from schema.sql with nothing able to observe it. "The
  // discipline is constant outside the tables its test watches, so nothing can
  // observe whether it holds there."
  const touched = new Set<string>();
  for (const sql of sources.values())
    for (const m of sql.matchAll(/(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+([a-z_]+)/gi))
      if (!/_new$|_old$/.test(m[1])) touched.add(m[1]);

  // A table may leave the byte-parity comparison ONLY with a reason written
  // here. 0043 adds its two columns by ALTER, which appends to the stored
  // CREATE, while schema.sql declares them inline with comments no ALTER can
  // reproduce -- so a migrated square and a fresh install hold the same columns
  // under different stored text. Rebuilding a hash-chained log table to make
  // the text match is a categorically larger risk than the cosmetic difference
  // it would remove, which is why this is accepted rather than fixed. It is
  // written down HERE, in the test, rather than only in the migration's prose,
  // because an exception that lives in prose is one nothing checks.
  const ACCEPTED_TEXT_DIVERGENCE = new Map<string, string>([
    ["identity_events", "0043 adds subject_thumbprint and proof_mode by ALTER; the columns match and only the stored DDL text differs. Asserted below, both halves."],
  ]);

  const fromMigration = new DatabaseSync(":memory:");
  fromMigration.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY);");
  for (const migration of migrations) fromMigration.exec(migration);
  const fromSchema = new DatabaseSync(":memory:");
  fromSchema.exec(SCHEMA);

  const compared = [...touched].filter((t) => !ACCEPTED_TEXT_DIVERGENCE.has(t)).sort();
  assert.ok(compared.length >= 2, `expected the migrations to touch tables to compare, derived ${compared.length}`);
  for (const table of touched)
    assert.ok(
      compared.includes(table) || (ACCEPTED_TEXT_DIVERGENCE.get(table) ?? "").length > 20,
      `${table} is touched by a migration and is neither compared nor accepted with a reason`,
    );

  const list = compared.map((t) => `'${t}'`).join(", ");
  const shape = (db: InstanceType<typeof DatabaseSync>) =>
    (db
      .prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN (${list}) ORDER BY name`)
      .all() as { type: string; name: string; sql: string | null }[])
      .map((r) => `${r.type} ${r.name}: ${(r.sql ?? "").replace(/\s+/g, " ")}`);

  assert.deepEqual(shape(fromMigration), shape(fromSchema), "the migrations and schema.sql must build the same thing, byte for byte");
  assert.ok(shape(fromSchema).some((s) => s.includes("holds INTEGER NOT NULL DEFAULT 0")), "0042's columns, in the shape a fresh install gets them");
  assert.ok(shape(fromSchema).some((s) => s.includes("idx_recovery_challenges_ip")), "the per-IP meter's index");
  assert.ok(shape(fromSchema).some((s) => s.includes("idx_recovery_challenges_citizen") && s.includes("created_at")), "the per-citizen index serves created_at, which is what is queried");
  assert.ok(shape(fromSchema).some((s) => s.includes("ip_hash")), "the meter's column");
});

test("0043's accepted divergence is real, and is confined to the stored text", async () => {
  // The other half of sundial's finding. An accepted exception that nothing
  // measures is prose, and prose goes stale silently: if 0043 were ever changed
  // to a rebuild, the entry in ACCEPTED_TEXT_DIVERGENCE above would keep
  // excusing a table that no longer needs excusing, and the byte-parity check
  // would stay switched off for it forever.
  //
  // So both halves are asserted here. The divergence EXISTS -- a migrated
  // square's stored DDL for identity_events differs from a fresh install's --
  // and it is CONFINED to that text: the column sets are identical, so no
  // reader, query or hash sees a difference between the two squares. That
  // second half is the whole reason the exception is tolerable, and it was the
  // half stated only in prose.
  const { DatabaseSync } = await import("node:sqlite");
  const migration = readFileSync(fileURLToPath(new URL("../migrations/0043_identity_event_typed_fields.sql", import.meta.url)), "utf8");

  // What schema.sql said before 0043: its identity_events block with the two
  // typed columns and the comment that introduces them taken back out. This is
  // reconstructed rather than pasted so it cannot rot away from the real file.
  const block = /CREATE TABLE IF NOT EXISTS identity_events \([\s\S]*?\n\);/.exec(SCHEMA);
  assert.ok(block, "schema.sql must declare identity_events where this test reads it");
  const before = block[0]
    .split("\n")
    .filter((line) => !/^\s*(subject_thumbprint|proof_mode)\b/.test(line) && !/Typed beside detail rather than inside it/.test(line))
    .join("\n");
  assert.ok(!/subject_thumbprint|proof_mode/.test(before), "the reconstruction must not already carry 0043's columns, or it proves nothing");
  assert.ok(before.split("\n").length + 3 === block[0].split("\n").length, "exactly three lines removed: two columns and the comment above them");

  const upgraded = new DatabaseSync(":memory:");
  upgraded.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY);");
  upgraded.exec(before);
  upgraded.exec(migration);
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(SCHEMA);

  const ddl = (db: InstanceType<typeof DatabaseSync>) =>
    String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'identity_events'").get() as { sql: string }).sql);
  const columns = (db: InstanceType<typeof DatabaseSync>) =>
    (db.prepare("SELECT name, type, \"notnull\", dflt_value FROM pragma_table_info('identity_events') ORDER BY name").all() as Record<string, unknown>[])
      .map((c) => `${c.name} ${c.type} ${c["notnull"]} ${c.dflt_value ?? ""}`);

  // KILLING MUTATION: change 0043 to rebuild the table instead of ALTERing it
  // -> this reds, and the accepted-divergence entry must then be deleted.
  assert.notEqual(ddl(upgraded), ddl(fresh), "the divergence this test accepts must actually exist; if it does not, remove the exception rather than keeping a dead excuse");

  // KILLING MUTATION: have 0043 add a third column, or a differently typed one
  // -> this reds, because the divergence would stop being cosmetic.
  assert.deepEqual(columns(upgraded), columns(fresh), "and it must be confined to the stored text: the two squares must hold the same columns, or the exception is not cosmetic and is not tolerable");
  assert.ok(columns(fresh).some((c) => c.startsWith("subject_thumbprint ")), "both squares carry 0043's first column");
  assert.ok(columns(fresh).some((c) => c.startsWith("proof_mode ")), "and its second");
});

test("the new event kinds are in the published events schema", async () => {
  // GET /api/events validates against schemas/events.json, where `kind` is a
  // CLOSED enum. Without this the very first recovery makes that endpoint
  // violate its own published contract.
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/events.json", import.meta.url)), "utf8"));
  const kinds: string[] = schema.properties.events.items.properties.kind.enum;
  for (const kind of ["recovery-opened", "recovery-cancelled", "recovery-completed", "recovery-held"]) {
    assert.ok(kinds.includes(kind), `${kind} is written by this feature and is not in the published enum`);
  }
});
