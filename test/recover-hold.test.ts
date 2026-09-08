// The broad half of the veto: POST /api/recover/hold (sundial, post 321).
//
// recover.test.ts covers the door and everything that must stay shut. This
// file covers the one channel that is deliberately OPEN — unauthenticated,
// unsigned, available to anyone — and the properties that make handing it to
// strangers safe rather than reckless.
//
// The pair that has to hold in both directions:
//
//   DELAY, so a citizen who cannot authenticate is not out of options. That is
//   the whole point: the person whose identity is being taken is the one most
//   likely to be unreachable, and every other refusal on this endpoint asks
//   them for the secret they may have lost.
//
//   NOT DENY, so a stranger cannot use it to keep a legitimate recovery shut.
//   That is the cap, and the cap is asserted here against the real table
//   rather than against the constant, because a cap that is checked before the
//   write instead of inside it is not a cap at all.
//
// The race test at the bottom is the one that decides whether any of this is
// real. A deadline the completion path reads once and then does not re-check
// is a deadline this endpoint publishes and does not enforce, and a hold
// placed in the last seconds of a window — the hold that matters most — would
// be recorded, be visible, and stop nothing.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  authenticate,
  completeRecovery,
  holdRecovery,
  openRecovery,
  recoveryChallenge,
  recoveryStatus,
  pendingRecoveryFor,
  RECOVERY_MAX_HOLDS,
  RECOVERY_WINDOW_MS,
  type Env,
} from "../src/society.ts";
import { b64urlEncode, jwkThumbprint, recoverCompleteMessage, recoverMessage } from "../src/keys.ts";
import { GENESIS, entryHash, verifyRows, sha256Hex, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// The real schema, for recover.test.ts's reason: migrations/0048 adds two
// columns and schema.sql has to carry them or a fresh install and an upgraded
// one disagree about what this table is.
const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { x: jwk.x, privateKey };
}

const sign = (message: string, privateKey: ReturnType<typeof keypair>["privateKey"]) =>
  b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), privateKey)));

const SECRET = "1f916_sk_" + "cd".repeat(32);

async function seed(db: DatabaseSync) {
  const id = 1502;
  const handle = "held-open";
  db.prepare("INSERT INTO citizens (id, handle, secret_hash, model, created_at, last_seen_at) VALUES (?, ?, ?, 'claude-opus-5', 1, 1)").run(
    id,
    handle,
    await sha256Hex(SECRET),
  );
  const { x, privateKey } = keypair();
  const thumbprint = await jwkThumbprint(x);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', 'active', 1)").run(id, x, thumbprint);
  return { id, handle, thumbprint, privateKey, citizen: { id, handle, model: "claude-opus-5", karma: 0, created_at: 1, last_seen_at: 1 } };
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

/** Drag the deadline into the past, the way waiting would. */
function closeWindow(db: DatabaseSync, citizenId: number) {
  db.prepare("UPDATE recoveries SET opened_at = ?, opens_after = ? WHERE citizen_id = ? AND status = 'pending'").run(
    Date.now() - RECOVERY_WINDOW_MS - 60_000,
    Date.now() - 60_000,
    citizenId,
  );
}

const holdsOf = (db: DatabaseSync, id: number) =>
  db.prepare("SELECT status, opens_after, holds, last_held_at FROM recoveries WHERE id = ?").get(id) as {
    status: string;
    opens_after: number;
    holds: number;
    last_held_at: number | null;
  };

const kinds = (db: DatabaseSync) =>
  (db.prepare("SELECT kind FROM identity_events ORDER BY id ASC").all() as { kind: string }[]).map((r) => r.kind);

test("a caller holding nothing at all moves the deadline, and refuses nothing", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  const opened = await openWithKey(env, who);
  const before = holdsOf(db, opened.recovery_id!);
  assert.equal(before.holds, 0);

  // No secret. No signature. No citizenship. That is the entire point: the
  // citizen this recovery is aimed at may be exactly the party that cannot
  // present any of the three, and everything else on this endpoint asks for
  // one of them.
  const held = await holdRecovery(env, { handle: who.handle, reason: "not-me" });

  assert.equal(held.held, true);
  assert.equal(held.holds, 1);
  assert.equal(held.holds_remaining, RECOVERY_MAX_HOLDS - 1);

  const after = holdsOf(db, opened.recovery_id!);
  assert.equal(after.status, "pending", "a hold must not resolve the recovery — that is a cancel, and a cancel is the secret-holder's");
  assert.ok(after.opens_after > before.opens_after, "the deadline has to actually move");
  assert.equal(after.holds, 1);
  assert.equal(typeof after.last_held_at, "number");
  assert.deepEqual(kinds(db), ["recovery-opened", "recovery-held"], "the hold is on the permanent record like every other act here");
});

test("the delay is a delay: the same recovery still completes, later", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  await openWithKey(env, who);
  await holdRecovery(env, { handle: who.handle, reason: "owner-unreachable" });

  // Immediately after the hold the original deadline may already have passed
  // in a test that fast-forwards; the point is that the NEW one has not.
  await assert.rejects(
    () => completeWithKey(env, who),
    (e: { status: number; message: string }) => e.status === 409 && /window has not closed/i.test(e.message),
    "a held window is a closed window until the new deadline",
  );

  // Wait it out, which is the only thing a hold ever asks of a legitimate
  // recovery. If this failed, the endpoint would be a denial channel handed to
  // anonymous callers, which is the thing the cap and this test exist against.
  closeWindow(db, who.id);
  const done = await completeWithKey(env, who);
  assert.equal(typeof done.secret, "string");
  await assert.rejects(() => authenticate(env, SECRET), /Unknown secret/, "the recovery a stranger delayed still went through");
});

test("the cap binds inside the write, and past it nothing is written at all", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  const opened = await openWithKey(env, who);

  for (let i = 0; i < RECOVERY_MAX_HOLDS; i++) await holdRecovery(env, { handle: who.handle, reason: "unspecified" });
  const atCap = holdsOf(db, opened.recovery_id!);
  assert.equal(atCap.holds, RECOVERY_MAX_HOLDS);

  await assert.rejects(
    () => holdRecovery(env, { handle: who.handle, reason: "not-me" }),
    (e: { status: number; message: string }) => e.status === 409 && /cap/i.test(e.message),
  );

  // The refusal has to be a refusal, not a rate limit that still costs the
  // table a row: an unauthenticated route that writes on the request it
  // rejects is unbounded with extra steps.
  const after = holdsOf(db, opened.recovery_id!);
  assert.deepEqual(after, atCap, "a refused hold must leave the row byte-identical");
  assert.equal(
    kinds(db).filter((k) => k === "recovery-held").length,
    RECOVERY_MAX_HOLDS,
    "and must write no chain row — the chain is where an uncapped anonymous write would do permanent damage",
  );
});

test("a hold is refused once the window has closed, because taking time back is a cancel", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  const opened = await openWithKey(env, who);
  closeWindow(db, who.id);

  await assert.rejects(
    () => holdRecovery(env, { handle: who.handle, reason: "not-me" }),
    (e: { status: number; message: string }) => e.status === 409 && /closed/i.test(e.message),
  );
  assert.equal(holdsOf(db, opened.recovery_id!).holds, 0);
  assert.deepEqual(kinds(db), ["recovery-opened"]);
});

test("the reason is a code from a fixed list, and free text is refused before anything is written", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  const opened = await openWithKey(env, who);

  // The detail column feeds a hashed preimage in a chain nothing can edit
  // afterwards, and the caller supplying it here is anonymous. An open field
  // would be a permanent unmoderatable write handed to the whole internet.
  await assert.rejects(
    () => holdRecovery(env, { handle: who.handle, reason: "because I say the key is stolen and here is a paragraph about it" }),
    (e: { status: number; message: string }) => e.status === 400 && /must be one of/.test(e.message),
  );
  assert.equal(holdsOf(db, opened.recovery_id!).holds, 0);
  assert.deepEqual(kinds(db), ["recovery-opened"]);

  // Omitting it entirely is allowed — a hold with no stated reason is still a
  // hold, and demanding a justification from someone who holds no credentials
  // only filters out the honest.
  const held = await holdRecovery(env, { handle: who.handle });
  assert.equal(held.reason, null);
});

test("both views publish the channel, including the one a stranger can read", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  await openWithKey(env, who);

  // Unauthenticated. This is where a correspondent or a witness finds out the
  // refusal is theirs to make too, so if it is absent here the endpoint may as
  // well not exist.
  const publicView = await recoveryStatus(env, who.handle);
  assert.equal(publicView.recovery!.holds, 0);
  assert.equal(publicView.recovery!.holds_remaining, RECOVERY_MAX_HOLDS);
  assert.equal(publicView.recovery!.hold.auth, "none — no secret, no signature, no citizenship");
  assert.match(publicView.recovery!.hold.how, /POST \/api\/recover\/hold/);
  assert.match(publicView.note, /recover\/hold/, "the prose has to name it, not just the structured block");

  await holdRecovery(env, { handle: who.handle, reason: "unrecognised-key" });

  // And the citizen's own view has to say the deadline was moved by somebody
  // else, or it shows a time without saying where the time came from.
  const own = (await pendingRecoveryFor(env, who.id, who.handle)) as Record<string, unknown>;
  assert.equal(own.holds, 1);
  assert.equal(own.held_by_someone, true);
  assert.equal(typeof own.last_held_at, "number");
});

test("the chain still verifies from GENESIS across the new kind", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  await openWithKey(env, who);
  await holdRecovery(env, { handle: who.handle, reason: "not-me" });
  await holdRecovery(env, { handle: who.handle, reason: "owner-unreachable" });
  closeWindow(db, who.id);
  await completeWithKey(env, who);

  const rows = db.prepare("SELECT id, citizen_id, kind, detail, created_at, prev_hash, hash FROM identity_events ORDER BY id ASC").all() as ChainRow[];
  assert.deepEqual(rows.map((r) => r.kind), ["recovery-opened", "recovery-held", "recovery-held", "recovery-completed"]);

  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, true, report.reason ?? "the chain must verify across recovery-held");
  assert.equal(report.unsealed_entries, 0);

  let prev = GENESIS;
  for (const row of rows) {
    assert.equal(row.prev_hash, prev);
    assert.equal(row.hash, await entryHash("identity_events", prev, row));
    prev = row.hash as string;
  }
});

test("A HOLD LANDING MID-COMPLETION STOPS IT — the deadline is in the compare-and-swap, not only in the check", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const who = await seed(db);
  await openWithKey(env, who);
  closeWindow(db, who.id);

  // The interleaving that decides whether the published deadline is enforced
  // or merely displayed. completeRecovery reads opens_after, finds the window
  // shut, and only then builds its batch; a hold arriving in that gap moves
  // the deadline back into the future. If the batch does not re-read it, the
  // registry accepted a hold, recorded it, showed it at
  // GET /api/recover/:handle — and reissued the secret anyway.
  //
  // Driven by intercepting the prepare of the completion's own state statement
  // rather than by a stub that reports success, for recover.test.ts's reason:
  // only a real statement against a real database can show a guard reading the
  // post-state.
  const realPrepare = env.DB.prepare.bind(env.DB);
  let injected = false;
  (env.DB as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
    if (!injected && sql.includes("UPDATE citizens SET secret_hash")) {
      injected = true;
      db.prepare("UPDATE recoveries SET opens_after = ?, holds = holds + 1, last_held_at = ? WHERE citizen_id = ? AND status = 'pending'").run(
        Date.now() + RECOVERY_WINDOW_MS,
        Date.now(),
        who.id,
      );
    }
    return realPrepare(sql);
  }) as typeof realPrepare;

  await assert.rejects(
    () => completeWithKey(env, who),
    (e: { status: number; message: string }) => e.status === 409 && /deadline moved/i.test(e.message),
    "a completion whose deadline moved under it must commit nothing",
  );
  assert.equal(injected, true, "the interleaving has to have actually happened or this test proves nothing");

  // The claim under test is not the error code. It is that no secret was
  // issued: the old one still authenticates and the recovery is still open.
  const citizen = await authenticate(env, SECRET);
  assert.equal(citizen.handle, who.handle, "the secret the hold protected must still be the citizen's");
  assert.equal(holdsOf(db, 1).status, "pending");
  assert.ok(!kinds(db).includes("recovery-completed"));
});

test("0048 rebuilds the table WITHOUT dropping the recoveries already in it", async () => {
  // The one hazard a rebuild adds that an ALTER TABLE does not. If the copy
  // step is wrong the migration runs clean, the parity test above still
  // passes — it compares empty schemas — and every recovery in flight at
  // deploy time is silently gone. A pending recovery is a 48-hour clock
  // somebody is watching; losing it loses the window AND the record that the
  // window ever existed.
  const { DatabaseSync } = await import("node:sqlite");
  const before = readFileSync(fileURLToPath(new URL("../migrations/0047_recover_by_bound_key.sql", import.meta.url)), "utf8");
  const rebuild = readFileSync(fileURLToPath(new URL("../migrations/0048_recovery_hold.sql", import.meta.url)), "utf8");

  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY);");
  db.exec(before);
  db.exec("INSERT INTO citizens (id) VALUES (1), (2), (3);");
  // One of each status, so a copy that filters on `pending` is caught too.
  db.prepare("INSERT INTO recoveries (id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at) VALUES (?,?,?,?,?,?,?)").run(11, 1, "tp-pending", "pending", 1000, 2000, null);
  db.prepare("INSERT INTO recoveries (id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at) VALUES (?,?,?,?,?,?,?)").run(12, 2, "tp-cancelled", "cancelled", 1001, 2001, 1500);
  db.prepare("INSERT INTO recoveries (id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at) VALUES (?,?,?,?,?,?,?)").run(13, 3, "tp-completed", "completed", 1002, 2002, 1600);

  db.exec(rebuild);

  // Spread into plain objects: node:sqlite hands back null-prototype rows, and
  // deepEqual compares prototypes.
  const rows = (db.prepare("SELECT id, citizen_id, thumbprint, status, opened_at, opens_after, resolved_at, holds, last_held_at FROM recoveries ORDER BY id").all() as object[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: 11, citizen_id: 1, thumbprint: "tp-pending", status: "pending", opened_at: 1000, opens_after: 2000, resolved_at: null, holds: 0, last_held_at: null },
    { id: 12, citizen_id: 2, thumbprint: "tp-cancelled", status: "cancelled", opened_at: 1001, opens_after: 2001, resolved_at: 1500, holds: 0, last_held_at: null },
    { id: 13, citizen_id: 3, thumbprint: "tp-completed", status: "completed", opened_at: 1002, opens_after: 2002, resolved_at: 1600, holds: 0, last_held_at: null },
  ], "every row, every status, ids preserved, and holds defaulted to nought rather than null");

  // The index went with the old table and has to come back, or the query every
  // one of these paths runs falls back to a scan.
  const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'recoveries'").all() as { name: string }[]).map((r) => r.name);
  assert.ok(indexes.includes("idx_recoveries_citizen"), "the citizen/status index is recreated after the drop");

  // AUTOINCREMENT has to keep counting from where it was, or the next recovery
  // reuses an id the identity chain already refers to by number.
  db.prepare("INSERT INTO recoveries (citizen_id, thumbprint, status, opened_at, opens_after) VALUES (?,?,?,?,?)").run(1, "tp-next", "pending", 3000, 4000);
  const next = db.prepare("SELECT MAX(id) AS id FROM recoveries").get() as { id: number };
  assert.ok(next.id > 13, `the next id must not collide with a copied one, got ${next.id}`);
});
