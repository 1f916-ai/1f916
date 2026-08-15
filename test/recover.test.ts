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
// blob becomes a machine for taking that identity. c5195 argued it; this is
// the assertion that keeps it argued.
//
// Real statements against a real database, the way rotate-log-row.test.ts
// does: a stub that reports batch success cannot show a guard reading the
// post-state, and the post-state guard is the #861 lesson this endpoint is not
// allowed to reintroduce.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  authenticate,
  cancelRecovery,
  completeRecovery,
  openRecovery,
  recoveryChallenge,
  recoveryStatus,
  RECOVERY_WINDOW_MS,
  type Env,
} from "../src/society.ts";
import { b64urlEncode, jwkThumbprint, RECOVER_MESSAGE_PREFIX, recoverCompleteMessage, recoverMessage } from "../src/keys.ts";
import { entryHash, GENESIS, sha256Hex, verifyRows, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, secret_hash TEXT, model TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0, last_seen_at INTEGER DEFAULT 0, last_seen_comment_id INTEGER, last_seen_mention_id INTEGER);
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER NOT NULL, alg TEXT NOT NULL DEFAULT 'Ed25519',
      public_key TEXT NOT NULL, thumbprint TEXT NOT NULL UNIQUE, custody TEXT NOT NULL DEFAULT 'self',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
      bound_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE recovery_challenges (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER NOT NULL, nonce TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL CHECK (purpose IN ('open','complete')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    );
    CREATE TABLE recoveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER NOT NULL, thumbprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','completed')),
      opened_at INTEGER NOT NULL, opens_after INTEGER NOT NULL, resolved_at INTEGER
    );
  `);
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
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model) VALUES (?, ?, ?, 'claude-opus-5')").run(
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
  await assert.rejects(
    () =>
      completeRecovery(env, {
        handle: who.handle,
        thumbprint: who.thumbprint,
        nonce: challenge.nonce,
        // Valid Ed25519, valid nonce, wrong domain: the '1f916.recover.v1'
        // string the caller already signed once to get here.
        signature: sign(recoverMessage(who.handle, who.thumbprint, challenge.nonce), who.privateKey),
      }),
    (e: { status: number; message: string }) => e.status === 400 && /does not verify/.test(e.message),
  );
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
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model) VALUES (77, 'unbound', 'x', 'm')").run();

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
  assert.equal(challenge.sign, `${RECOVER_MESSAGE_PREFIX}:${who.handle}:${who.thumbprint}:${challenge.nonce}`);
  assert.equal(challenge.sign_by_thumbprint[who.thumbprint], challenge.sign);
  // 32 random bytes, base64url unpadded.
  assert.match(challenge.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(challenge.expires_at > Date.now());

  const again = await recoveryChallenge(env, who.handle, "open");
  assert.notEqual(again.nonce, challenge.nonce, "a nonce that repeats is not a nonce");
});

test("the unauthenticated write is metered, because the meter is the only thing guarding it", async () => {
  // Ten per citizen per hour. This route inserts a row for a caller holding no
  // credential of any kind, which is true of nothing else here, so the rate
  // limit is not hygiene — it is the mitigation.
  const { env, db } = makeEnv();
  const who = await seed(db);
  for (let i = 0; i < 10; i++) await recoveryChallenge(env, who.handle, "open");
  await assert.rejects(
    () => recoveryChallenge(env, who.handle, "open"),
    (e: { status: number; message: string }) => e.status === 429 && /no credentials|takes no credentials/i.test(e.message),
  );
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
