// Registry key rotation: the key that signs every checkpoint head,
// every dossier and every doorbell ring can be rotated, and nothing signed
// before the rotation stops verifying.
//
// Before this change the key could not be changed at all: one REGISTRY_SEED,
// no key named anywhere a head is stored, and the dossier's verify_offline
// carried the key as a literal. These tests are red on main because
// src/registry-keys.ts, registry_keys, checkpoints.key_epoch and
// registry_key_history do not exist there.
//
// What each test pins, in the order an operator meets it:
//   - epoch 0 is today's key, derived from REGISTRY_SEED until the first cron
//     pass records it, and never recorded from a seed that does not verify the
//     oldest and newest heads already signed (the stamp still runs; only the
//     rotation is refused);
//   - the rotation refuses unless the OLD key is present to sign it, refuses a
//     second rotation before the secrets are moved, and refuses a retired key;
//   - a rotation leaves a statement both keys signed, chained as an identity
//     event, and new heads under the new epoch, while pre-rotation heads still
//     verify under epoch 0 and a head the retired key signed after its
//     retirement does not;
//   - a head signed with the old key while a rotation commits is not written;
//   - dossiers and doorbells name the epoch of the key that signed them.
//
// Killing mutations (each turns a test red):
//   1. Drop the primary.pub !== active.public_key check in rotateRegistryKey:
//      "the old key must sign" goes red (the rotation commits with a key that
//      is not the active one's holder).
//   2. Sign the statement with next.seed twice: the old_sig assertion goes red.
//   3. Drop the retired_at comparison in verifyCheckpointRow: the post-
//      retirement forgery verifies.
//   4. Drop the WHERE on the checkpoint insert: the race test writes a stale head.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as edVerify, createPublicKey, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { repoAssets } from "./helpers/repo-assets.ts";
import { latestCheckpoints, makeCheckpoints, checkpointPayload, inclusion, consistency, checkpointNote } from "../src/checkpoint.ts";
import { verifyNote, parseNote, parseCheckpoint } from "../src/note.ts";
import {
  readRegistryKeyHistory,
  rotateRegistryKey,
  rotationStatement,
  verifyCheckpointRow,
  REGISTRY_ROTATE_KIND,
  signWithSeed,
  REGISTRY_KEY_HISTORY_CAP,
  withKeyEpoch,
  isMissingKeyEpochColumn,
  isMissingRegistryKeysTable,
  checkersMissingKeyEpochs,
  KEY_EPOCH_CAPABILITY,
  KEY_EPOCH_CHECKERS,
} from "../src/registry-keys.ts";
import { record, PUBLISHED_REGISTRY_KEY } from "../src/record.ts";
import { ringDoorbells } from "../src/doorbell.ts";
import type { Env } from "../src/society.ts";

const FULL_SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const IDENTITY = "identity_events";
const B64URL = "base64url";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

interface Pair {
  secret: string;
  pub: string;
  seed: Uint8Array;
}

function pair(): Pair {
  const kp = generateKeyPairSync("ed25519");
  const der = kp.privateKey.export({ format: "der", type: "pkcs8" });
  const seed = new Uint8Array(der.subarray(der.length - 32));
  const pub = (kp.publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { secret: `${Buffer.from(seed).toString(B64URL)}.${pub}`, pub, seed };
}

function nodeVerify(pub: string, message: string, sig: string): boolean {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(pub, B64URL)]), format: "der", type: "spki" });
  return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(sig, B64URL));
}

function setup(seed?: string, next?: string) {
  const t = sqliteTestEnv(FULL_SCHEMA);
  t.db.exec(`INSERT INTO citizens (id, handle, model, karma, created_at, secret_hash, last_seen_at) VALUES
             (1,'maintainer','m',0,0,'x',0),(2,'alice','m',0,0,'y',0);`);
  const env = t.env as unknown as Record<string, unknown>;
  // The deployed source mirror, so the rotation gate reads the vendored
  // checkers this branch ships.
  env.ASSETS = repoAssets();
  if (seed) env.REGISTRY_SEED = seed;
  if (next) env.REGISTRY_SEED_NEXT = next;
  return { env: t.env, db: t.db, vars: env };
}

// One sealed identity event, so the identity tree grows and the next pass
// writes a head for it.
function grow(db: ReturnType<typeof setup>["db"], n: number) {
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (2, 'test', NULL, ?, NULL, ?)").run(n, `${n}`.padStart(64, "0"));
}

type Row = { log: string; tree_size: number; root: string; sig: string; created_at: number; key_epoch: number };
function heads(db: ReturnType<typeof setup>["db"]): Row[] {
  return db.prepare("SELECT log, tree_size, root, sig, created_at, key_epoch FROM checkpoints ORDER BY id").all() as unknown as Row[];
}

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? -1;
  }
}

test("before anything is recorded, epoch 0 is the key REGISTRY_SEED holds, served as unrecorded", async () => {
  const a = pair();
  const { env } = setup(a.secret);
  const cp = (await latestCheckpoints(env)) as unknown as Record<string, any>;
  assert.equal(cp.registry_public_key.x, a.pub);
  assert.equal(cp.registry_key_epoch, 0);
  assert.equal(cp.registry_key_history_recorded, false);
  assert.deepEqual(cp.registry_key_history, [{ epoch: 0, public_key: a.pub, activated_at: 0, retired_at: null, rotation: null }]);
  assert.equal(cp.rotation_statement_format, "1f916.registry-rotate.v1:<epoch>:<old_public_key>:<new_public_key>:<at>:<log>=<tree_size>=<root>[,<log>=<tree_size>=<root>...]");
});

test("the first cron pass records epoch 0 and stamps key_epoch 0 on the heads it signs", async () => {
  const a = pair();
  const { env, db } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  const history = await readRegistryKeyHistory(env);
  assert.equal(history.recorded, true);
  assert.deepEqual(history.rows.map((r) => [r.epoch, r.public_key, r.retired_at]), [[0, a.pub, null]]);
  const rows = heads(db);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.key_epoch, 0);
    assert.deepEqual(await verifyCheckpointRow(history.rows, r), { ok: true });
  }
});

test("epoch 0 is never recorded from a seed that does not verify the heads already signed", async () => {
  const a = pair();
  const b = pair();
  const { env, db } = setup(b.secret);
  const created = 1789400000000;
  const sig = await signWithSeed(a.seed, checkpointPayload(IDENTITY, 0, "r", created));
  db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, 0, 'r', ?, ?)").run(IDENTITY, sig, created);
  // The stamping job carries on as it did before key epochs (a stamp is never
  // the thing that stops), but the swapped key is not written down as epoch 0.
  const said: string[] = [];
  const real = console.error;
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    assert.equal(await status(makeCheckpoints(env)), 0);
    // A second pass: the newest head is now the swapped key's own, and the
    // oldest one still refuses it.
    grow(db, 1);
    assert.equal(await status(makeCheckpoints(env)), 0);
  } finally {
    console.error = real;
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM registry_keys").get() as { n: number }).n, 0);
  assert.ok(said.some((l) => /not recorded as epoch 0/.test(l)), "the refusal is said");
  assert.equal((await readRegistryKeyHistory(env)).recorded, false);
  // And with nothing recorded there is nothing to rotate from.
  (env as unknown as Record<string, unknown>).REGISTRY_SEED_NEXT = a.secret;
  assert.equal(await status(rotateRegistryKey(env)), 503);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'registry-rotate'").get() as { n: number }).n, 0);
});

test("a rotation needs REGISTRY_SEED_NEXT, and needs the OLD key in REGISTRY_SEED to sign it", async () => {
  const a = pair();
  const b = pair();
  const c = pair();
  const { env, db, vars } = setup(a.secret);
  await makeCheckpoints(env);
  assert.equal(await status(rotateRegistryKey(env)), 409, "no next key");
  // Only new keys in hand: the active key (a) is in neither secret, so the
  // statement cannot carry its signature and the rotation is refused.
  vars.REGISTRY_SEED = b.secret;
  vars.REGISTRY_SEED_NEXT = c.secret;
  assert.equal(await status(rotateRegistryKey(env)), 409, "the old key must sign");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM registry_keys").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'registry-rotate'").get() as { n: number }).n, 0);
  // And the signer will not sign with a key the history does not name.
  assert.equal(await status(makeCheckpoints(env)), 503);
});

test("a rotation: both keys sign the statement, it is chained, new heads take epoch 1, old heads still verify under epoch 0", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  const before = heads(db);
  vars.REGISTRY_SEED_NEXT = b.secret;

  const r = (await rotateRegistryKey(env)) as Record<string, any>;
  assert.equal(r.epoch, 1);
  // The statement commits to the old key's final head of every log: the
  // newest head of each when the rotation was made.
  const newestBefore = ["identity_events", "ledger"].map((log) => before.filter((h) => h.log === log).at(-1)!).map((h) => ({ log: h.log, tree_size: h.tree_size, root: h.root }));
  assert.deepEqual(r.final_heads, newestBefore);
  assert.equal(r.statement, rotationStatement(1, a.pub, b.pub, r.activated_at, newestBefore));
  assert.ok(r.statement.endsWith(newestBefore.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",")));
  assert.ok(nodeVerify(a.pub, r.statement, r.old_sig), "old_sig verifies under the OLD key");
  assert.ok(nodeVerify(b.pub, r.statement, r.new_sig), "new_sig verifies under the NEW key");
  assert.ok(r.activated_at > Math.max(...before.map((h) => h.created_at)), "the boundary sits after every head already signed");

  const event = db.prepare("SELECT citizen_id, kind, detail, hash FROM identity_events WHERE kind = ?").get(REGISTRY_ROTATE_KIND) as Record<string, any>;
  assert.equal(event.citizen_id, 1);
  assert.equal(event.hash, r.chained);
  assert.ok(event.detail.includes(r.statement) && event.detail.includes(r.old_sig) && event.detail.includes(r.new_sig), "the chained event carries everything needed to re-verify");

  const history = await readRegistryKeyHistory(env);
  assert.deepEqual(
    history.rows.map((h) => [h.epoch, h.public_key, h.retired_at]),
    [
      [0, a.pub, r.activated_at],
      [1, b.pub, null],
    ],
  );

  // Step 2 done, step 3 not yet: REGISTRY_SEED still holds the old key and
  // the signer takes the active key from REGISTRY_SEED_NEXT.
  await makeCheckpoints(env);
  const after = heads(db).filter((h) => h.key_epoch === 1);
  assert.equal(after.length, 1, "the identity tree grew by the rotation event; its head is signed under epoch 1");
  assert.deepEqual(await verifyCheckpointRow(history.rows, after[0]), { ok: true });
  assert.ok(nodeVerify(b.pub, checkpointPayload(after[0].log, after[0].tree_size, after[0].root, after[0].created_at), after[0].sig));

  // Pre-rotation heads: still verify, under epoch 0 and only under epoch 0.
  for (const h of before) {
    assert.equal(h.key_epoch, 0);
    assert.deepEqual(await verifyCheckpointRow(history.rows, h), { ok: true });
    assert.equal((await verifyCheckpointRow(history.rows, { ...h, key_epoch: 1 })).ok, false);
  }

  // What a leaked old key could still do: sign a head and call it epoch 0.
  // Dated after the retirement, it does not verify.
  const late = r.activated_at + 1;
  const forged = { log: IDENTITY, tree_size: 99, root: "f", created_at: late, key_epoch: 0, sig: await signWithSeed(a.seed, checkpointPayload(IDENTITY, 99, "f", late)) };
  const verdict = await verifyCheckpointRow(history.rows, forged);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /retired/);

  // A second rotation before the secrets are moved is refused.
  assert.equal(await status(rotateRegistryKey(env)), 409);

  // Step 3: the new key moves into REGISTRY_SEED and NEXT is deleted.
  vars.REGISTRY_SEED = b.secret;
  delete vars.REGISTRY_SEED_NEXT;
  grow(db, 2);
  await makeCheckpoints(env);
  assert.equal(heads(db).at(-2)?.key_epoch, 1);

  // A retired key never comes back.
  vars.REGISTRY_SEED_NEXT = a.secret;
  assert.equal(await status(rotateRegistryKey(env)), 409);

  // The proof routes serve the epoch of the head they prove against, so a
  // reader verifying a proof picks the right key without a second lookup.
  const firstEvent = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1").get() as { id: number }).id;
  const proof = (await inclusion(env, IDENTITY, String(firstEvent))) as Record<string, any>;
  assert.equal(proof.checkpoint.key_epoch, 0, "the smallest head covering the first event predates the rotation");
  const ids = heads(db).filter((h) => h.log === IDENTITY);
  const span = (await consistency(env, IDENTITY, String(ids[0].tree_size), String(ids.at(-1)!.tree_size))) as Record<string, any>;
  assert.deepEqual([span.from.key_epoch, span.to.key_epoch], [0, 1], "a consistency proof across a rotation names both epochs");

  const cp = (await latestCheckpoints(env)) as unknown as Record<string, any>;
  assert.equal(cp.registry_public_key.x, b.pub);
  assert.equal(cp.registry_key_epoch, 1);
  assert.equal(cp.registry_key_history[1].rotation.statement, r.statement);

  // The signed-note form of each stamp follows the same epochs: a note is
  // signed by its stamp's key, the active verifier key is the new one, and
  // every epoch's verifier key is served so a note from before the rotation
  // still verifies under its own.
  assert.deepEqual(cp.note.verifier_keys.map((k: { key_epoch: number }) => k.key_epoch), [0, 1]);
  assert.equal(cp.note.verifier_key, cp.note.verifier_keys[1].verifier_key);
  const oldNote = await checkpointNote(env, IDENTITY, before.find((h) => h.log === IDENTITY)!.tree_size);
  assert.equal(await verifyNote(oldNote, cp.note.verifier_keys[0].verifier_key), true, "a pre-rotation note verifies under epoch 0");
  assert.equal(await verifyNote(oldNote, cp.note.verifier_keys[1].verifier_key), false);
  const newNote = await checkpointNote(env, IDENTITY, undefined);
  assert.equal(parseCheckpoint(parseNote(newNote).body).treeSize, heads(db).filter((h) => h.log === IDENTITY).at(-1)!.tree_size);
  assert.equal(await verifyNote(newNote, cp.note.verifier_key), true, "a post-rotation note verifies under epoch 1");
  assert.equal(await verifyNote(newNote, cp.note.verifier_keys[0].verifier_key), false, "and not under the retired key");
});

test("a head signed with the old key while a rotation commits is not written", async () => {
  const a = pair();
  const b = pair();
  const { env, db } = setup(a.secret);
  await makeCheckpoints(env);
  grow(db, 1);
  // Commit an epoch-1 row between the signer's read and the insert, the way
  // a concurrent rotation would. The insert's WHERE sees it and writes nothing.
  const prepare = db.prepare.bind(db);
  let raced = false;
  const e = env as unknown as { DB: { prepare: (sql: string) => unknown } };
  const inner = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql: string) => {
    if (!raced && sql.startsWith("INSERT OR IGNORE INTO checkpoints")) {
      raced = true;
      prepare("UPDATE registry_keys SET retired_at = 5 WHERE epoch = 0").run();
      prepare("INSERT INTO registry_keys (epoch, public_key, activated_at, statement, old_sig, new_sig) VALUES (1, ?, 5, 's', 'o', 'n')").run(b.pub);
    }
    return inner(sql);
  };
  const out = await makeCheckpoints(env);
  assert.ok(raced);
  assert.equal(out.find((o) => o.log === IDENTITY)?.skipped, true);
  assert.equal(heads(db).filter((h) => h.log === IDENTITY).length, 1, "only the pre-race head exists");
});

test("dossiers are signed by the active key and say which epoch; the checkpoint's epoch rides outside the signed core", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  let d = (await record(env, "alice")) as Record<string, any>;
  assert.equal(d.registry_sig.registry_public_key, a.pub);
  assert.equal(d.registry_sig.key_epoch, 0);
  assert.equal(d.checkpoint_key_epoch, 0);
  assert.equal("key_epoch" in d.checkpoint, false, "the signed core keeps the shape verify.mjs rebuilds");
  assert.ok(d.verify_offline.includes(`--registry-key ${PUBLISHED_REGISTRY_KEY}`), "the pin is the published key");
  assert.ok(d.verify_offline.includes(a.pub), "and the key that signed is named beside it");

  vars.REGISTRY_SEED_NEXT = b.secret;
  await rotateRegistryKey(env);
  d = (await record(env, "alice")) as Record<string, any>;
  assert.equal(d.registry_sig.registry_public_key, b.pub);
  assert.equal(d.registry_sig.key_epoch, 1);
  assert.equal(d.checkpoint_key_epoch, 0, "the newest head predates the rotation and says so");
  assert.ok(d.verify_offline.includes(`--registry-key ${b.pub}`), "after the rotation the pin is the active key");
  assert.ok(!d.verify_offline.includes(`--registry-key ${PUBLISHED_REGISTRY_KEY}`), "never the retired published key");
  assert.ok(d.verify_offline.includes(`signed by ${b.pub}`));
  assert.match(d.verify_offline, /registry_sig.key_epoch 1/);
});

test("a doorbell ring names the epoch of the key that signed it", async () => {
  const { env, db } = setup(pair().secret);
  db.exec(`INSERT INTO doorbells (citizen_id, url, status, challenge, created_at, verification_version, wake_on) VALUES (2, 'https://bell.invalid/', 'active', 'c', 0, 1, 'anything');`);
  const seen: Record<string, string>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    seen.push(init?.headers as Record<string, string>);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await ringDoorbells(env as Env, 5, async () => "sig", "key-b", 0, 0, 0, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]["X-1f916-Registry-Key"], "key-b");
  assert.equal(seen[0]["X-1f916-Registry-Key-Epoch"], "1");
});

test("a stamp that lands while a rotation is being prepared makes the rotation write nothing; a retry places the boundary after it", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = b.secret;
  // The cron stamps under epoch 0 after the rotation read the newest stamp and
  // chose its boundary, and before its batch runs: that stamp's created_at is
  // past the boundary the rotation chose.
  const late = Date.now() + 60_000;
  const e = env as unknown as { DB: { prepare: (sql: string) => unknown } };
  const inner = e.DB.prepare.bind(e.DB);
  let landed = false;
  e.DB.prepare = (sql: string) => {
    if (!landed && sql.startsWith("UPDATE registry_keys SET retired_at")) {
      landed = true;
      grow(db, 1);
      db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at, key_epoch) VALUES (?, 1, 'r', ?, ?, 0)").run(IDENTITY, "s", late);
    }
    return inner(sql);
  };
  assert.equal(await status(rotateRegistryKey(env)), 409);
  assert.ok(landed);
  e.DB.prepare = inner;
  assert.deepEqual((db.prepare("SELECT epoch, retired_at FROM registry_keys ORDER BY epoch").all() as { epoch: number; retired_at: number | null }[]).map((r) => [r.epoch, r.retired_at]), [[0, null]], "nothing retired, nothing added");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'registry-rotate'").get() as { n: number }).n, 0, "nothing chained");
  // Retried, the boundary is after the stamp that landed, so that stamp still
  // verifies as an epoch 0 head made before the retirement.
  const r = (await rotateRegistryKey(env)) as Record<string, any>;
  assert.ok(r.activated_at > late);
});

test("a read error on the key history is thrown, never served as an unrecorded epoch 0", async () => {
  const a = pair();
  const b = pair();
  const { env, vars } = setup(a.secret);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = b.secret;
  await rotateRegistryKey(env);
  const e = env as unknown as { DB: { prepare: (sql: string) => unknown } };
  const inner = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql: string) => {
    if (sql.includes("FROM registry_keys ORDER BY epoch")) throw new Error("D1_ERROR: Network connection lost.");
    return inner(sql);
  };
  await assert.rejects(readRegistryKeyHistory(env), /Network connection lost/);
  await assert.rejects(latestCheckpoints(env), /Network connection lost/);
  e.DB.prepare = inner;
  // The one case that degrades: the table does not exist yet.
  const { env: bare, db: bareDb } = setup(a.secret);
  bareDb.exec("DROP TABLE registry_keys");
  const h = await readRegistryKeyHistory(bare);
  assert.equal(h.recorded, false);
  assert.equal(h.rows[0].public_key, a.pub);
});

test("a history longer than one response keeps the NEWEST epochs, ending at the active key, and says so", async () => {
  const fake = (i: number) => `k${String(i).padStart(42, "0")}`;
  const fill = (db: ReturnType<typeof setup>["db"], count: number) => {
    db.prepare("INSERT INTO registry_keys (epoch, public_key, activated_at, retired_at) VALUES (0, ?, 0, 1)").run(fake(0));
    for (let i = 1; i < count; i++)
      db.prepare("INSERT INTO registry_keys (epoch, public_key, activated_at, retired_at, statement, old_sig, new_sig) VALUES (?, ?, ?, ?, 's', 'o', 'n')").run(i, fake(i), i, i === count - 1 ? null : i + 1);
  };
  const a = pair();
  const over = setup(a.secret);
  fill(over.db, REGISTRY_KEY_HISTORY_CAP + 1);
  const h = await readRegistryKeyHistory(over.env);
  assert.equal(h.rows.length, REGISTRY_KEY_HISTORY_CAP);
  assert.equal(h.rows[0].epoch, 1, "the oldest is the one left out");
  assert.equal(h.rows.at(-1)!.epoch, REGISTRY_KEY_HISTORY_CAP, "the active key is always served");
  assert.equal(h.rows.at(-1)!.retired_at, null);
  assert.equal(h.has_more, true);
  const exact = setup(a.secret);
  fill(exact.db, REGISTRY_KEY_HISTORY_CAP);
  const e2 = await readRegistryKeyHistory(exact.env);
  assert.equal(e2.rows.length, REGISTRY_KEY_HISTORY_CAP);
  assert.equal(e2.rows[0].epoch, 0);
  assert.equal(e2.has_more, false, "exactly at the cap, nothing was left out");
});

test("an error that merely names key_epoch or registry_keys is thrown: only the missing-schema wording falls back", async () => {
  // The stamp insert: a lock on registry_keys must not send the stamp to the
  // old insert, which has no guard on the active epoch.
  const a = pair();
  const { env, db } = setup(a.secret);
  grow(db, 1);
  const e = env as unknown as { DB: { prepare: (sql: string) => unknown } };
  const inner = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql: string) => {
    if (sql.startsWith("INSERT OR IGNORE INTO checkpoints (log, tree_size, root, sig, created_at, key_epoch)"))
      return { bind: () => ({ run: async () => { throw new Error("D1_ERROR: database table is locked: registry_keys"); } }) };
    return inner(sql);
  };
  await assert.rejects(makeCheckpoints(env), /database table is locked: registry_keys/);
  e.DB.prepare = inner;
  assert.equal(heads(db).length, 0, "nothing was written by the unguarded insert");

  // A read: a busy error that mentions the column is thrown, never answered
  // with the pre-migration "0 AS key_epoch".
  await assert.rejects(
    withKeyEpoch(async (col) => {
      if (col === ", key_epoch") throw new Error("SQLITE_BUSY: database is locked while reading checkpoints.key_epoch");
      return "fell back";
    }),
    /SQLITE_BUSY/,
  );
  assert.equal(
    await withKeyEpoch(async (col) => {
      if (col === ", key_epoch") throw new Error("D1_ERROR: no such column: key_epoch: SQLITE_ERROR");
      return "fell back";
    }),
    "fell back",
  );
  assert.equal(isMissingKeyEpochColumn(new Error("table checkpoints has no column named key_epoch")), true);
  assert.equal(isMissingKeyEpochColumn(new Error("no such column: c.key_epoch")), true);
  assert.equal(isMissingRegistryKeysTable(new Error("D1_ERROR: no such table: registry_keys: SQLITE_ERROR")), true);
  assert.equal(isMissingRegistryKeysTable(new Error("database table is locked: registry_keys")), false);
});

test("a dossier is never served unsigned while a rotation's secrets are half moved", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED = "";
  vars.REGISTRY_SEED_NEXT = b.secret;
  assert.equal(await status(record(env, "alice")), 503);
  // No key configured at all is the one labeled unsigned case.
  delete vars.REGISTRY_SEED_NEXT;
  const d = (await record(env, "alice")) as Record<string, any>;
  assert.equal(d.registry_sig, null);
  assert.equal("registry_key_history" in d, false);
});

test("a fresh dossier's instruction trusts only the active key, and the ring note refuses a retired key's late rings", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = b.secret;
  await rotateRegistryKey(env);
  const d = (await record(env, "alice")) as Record<string, any>;
  assert.match(d.verify_offline, /must verify under the active key/i);
  assert.match(d.verify_offline, /counts only if you saved it before that key's retired_at/);
  assert.doesNotMatch(d.verify_offline, /reachable/, "a retired key is never a route to trusting a fresh dossier");
  assert.deepEqual(d.registry_key_history.map((h: { epoch: number }) => h.epoch), [0, 1], "served beside the dossier for the offline check");
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.match(src, /refuse a ring whose sent_at is at or after its epoch's retired_at/);
});

test("the rotation refuses until the verify.mjs and witness.mjs this deployment serves can follow it", async () => {
  const a = pair();
  const b = pair();
  const old = 'console.log("a checker that reads registry_public_key alone");\n';
  for (const [assets, names] of [
    [undefined, /serves no source mirror/],
    [repoAssets({ "vendor/protocol/verify.mjs": old }), /vendor\/protocol\/verify\.mjs as served/],
    [repoAssets({ "vendor/protocol/witness.mjs": null }), /vendor\/protocol\/witness\.mjs as served/],
    // The marker counts only as its own line at the top, not as text a comment
    // further down happens to contain.
    [repoAssets({ "vendor/protocol/verify.mjs": "#!/usr/bin/env node\n1\n2\n3\n4\n5\n// capability: registry-key-epochs v1\n" }), /vendor\/protocol\/verify\.mjs as served/],
  ] as const) {
    const { env, db, vars } = setup(a.secret, b.secret);
    vars.ASSETS = assets;
    await makeCheckpoints(env);
    let said = "";
    try {
      await rotateRegistryKey(env);
    } catch (e) {
      said = `${(e as { status?: number }).status} ${(e as Error).message}`;
    }
    assert.match(said, /^409 not rotating: /);
    assert.match(said, names);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM registry_keys WHERE epoch > 0").get() as { n: number }).n, 0, "nothing rotated");
  }
  // The copies vendored on this branch carry the capability line, and pass.
  const { env, vars } = setup(a.secret, b.secret);
  assert.equal(await checkersMissingKeyEpochs(env), null);
  await makeCheckpoints(env);
  assert.equal(((await rotateRegistryKey(env)) as Record<string, any>).epoch, 1);
  for (const f of KEY_EPOCH_CHECKERS) assert.ok(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").includes(KEY_EPOCH_CAPABILITY), f);
  void vars;
});

test("a proof is served without the key history, not refused, when the key is misconfigured and nothing is recorded", async () => {
  const a = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  db.exec("DELETE FROM registry_keys");
  vars.REGISTRY_SEED = "not-a-seed";
  const event = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1").get() as { id: number }).id;
  const p = (await inclusion(env, IDENTITY, String(event))) as Record<string, any>;
  assert.equal("registry_key_history" in p, false);
  assert.ok(Array.isArray(p.proof));
  const size = heads(db).find((h) => h.log === IDENTITY)!.tree_size;
  const c = (await consistency(env, IDENTITY, String(size), String(size))) as Record<string, any>;
  assert.equal("registry_key_history" in c, false);
  // With the key configured, the history rides beside the proof.
  vars.REGISTRY_SEED = a.secret;
  const q = (await inclusion(env, IDENTITY, String(event))) as Record<string, any>;
  assert.deepEqual(q.registry_key_history.map((h: { epoch: number }) => h.epoch), [0]);
});

test("a holder of the retired key cannot add a head past the final heads both keys committed to, whatever date it writes", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = b.secret;
  const r = (await rotateRegistryKey(env)) as Record<string, any>;
  const history = await readRegistryKeyHistory(env);
  const fin = (r.final_heads as { log: string; tree_size: number; root: string }[]).find((h) => h.log === IDENTITY)!;
  // Dated just before the retirement, so every date rule passes it.
  const at = r.activated_at - 1;
  const past = { log: IDENTITY, tree_size: fin.tree_size + 1, root: "e".repeat(64), created_at: at, key_epoch: 0, sig: await signWithSeed(a.seed, checkpointPayload(IDENTITY, fin.tree_size + 1, "e".repeat(64), at)) };
  const verdict = await verifyCheckpointRow(history.rows, past);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /goes past what both keys committed to/);
  const otherRoot = { ...past, tree_size: fin.tree_size, sig: await signWithSeed(a.seed, checkpointPayload(IDENTITY, fin.tree_size, "e".repeat(64), at)) };
  assert.equal((await verifyCheckpointRow(history.rows, otherRoot)).ok, false, "nor another root at the committed size");
  // The genuine final head still verifies.
  const genuine = heads(db).filter((h) => h.log === IDENTITY && h.key_epoch === 0).at(-1)!;
  assert.deepEqual(await verifyCheckpointRow(history.rows, genuine), { ok: true });
  // And the served history carries the final heads the statement names.
  assert.deepEqual(history.rows[1].final_heads && JSON.parse(history.rows[1].final_heads), r.final_heads);
});

test("an inclusion proof under an old head below the final head carries the consistency proof to it", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env); // identity head at size 1
  grow(db, 2);
  grow(db, 3);
  await makeCheckpoints(env); // identity head at size 3: the final head
  vars.REGISTRY_SEED_NEXT = b.secret;
  const r = (await rotateRegistryKey(env)) as Record<string, any>;
  const firstEvent = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1").get() as { id: number }).id;
  const p = (await inclusion(env, IDENTITY, String(firstEvent))) as Record<string, any>;
  assert.equal(p.checkpoint.tree_size, 1);
  const fin = r.final_heads.find((h: { log: string }) => h.log === IDENTITY);
  assert.deepEqual(p.final_consistency.to, fin);
  assert.deepEqual(p.final_consistency.from, { tree_size: 1, root: p.checkpoint.root });
  assert.ok(Array.isArray(p.final_consistency.proof) && p.final_consistency.proof.length > 0);
  // An event under the final head itself needs no link.
  const third = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1 OFFSET 2").get() as { id: number }).id;
  const q = (await inclusion(env, IDENTITY, String(third))) as Record<string, any>;
  assert.equal(q.checkpoint.tree_size, 3);
  assert.equal("final_consistency" in q, false);
});

test("a stamp under a new epoch is never dated before that epoch's activation", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = b.secret;
  await rotateRegistryKey(env);
  // A clock that runs behind the instant the rotation chose: move the
  // boundary an hour into the future.
  const ahead = Date.now() + 3_600_000;
  db.prepare("UPDATE registry_keys SET retired_at = ? WHERE epoch = 0").run(ahead);
  db.prepare("UPDATE registry_keys SET activated_at = ? WHERE epoch = 1").run(ahead);
  grow(db, 2);
  await makeCheckpoints(env);
  const fresh = heads(db).filter((h) => h.key_epoch === 1);
  assert.ok(fresh.length > 0);
  for (const h of fresh) assert.ok(h.created_at >= ahead, `stamped at ${h.created_at}, before its epoch began at ${ahead}`);
});

test("no rotation while independent witnesses are configured: each pins the current note key", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret, b.secret);
  await makeCheckpoints(env);
  // A comment-only value contacts nobody (src/witness-network.ts reads it
  // that way), so it does not block.
  vars.TLOG_WITNESSES = "# none yet";
  assert.equal(await checkersMissingKeyEpochs(env), null);
  const wk = generateKeyPairSync("ed25519");
  const wpub = Buffer.from((wk.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const wname = "witness.example/w1";
  const wid = createHash("sha256").update(Buffer.concat([Buffer.from(wname + "\n"), Buffer.from([0x04]), wpub])).digest().subarray(0, 4).toString("hex");
  vars.TLOG_WITNESSES = `https://witness.example ${wname}+${wid}+${Buffer.concat([Buffer.from([0x04]), wpub]).toString("base64")}`;
  let said = "";
  try {
    await rotateRegistryKey(env);
  } catch (e) {
    said = `${(e as { status?: number }).status} ${(e as Error).message}`;
  }
  assert.match(said, /^409 not rotating: TLOG_WITNESSES names independent witnesses \(witness\.example\/w1\)/);
  assert.match(said, /give every listed witness's operator the new key/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM registry_keys WHERE epoch > 0").get() as { n: number }).n, 0);
  vars.TLOG_WITNESSES = "# none yet";
  assert.equal(((await rotateRegistryKey(env)) as Record<string, any>).epoch, 1, "a value that names no witness does not block");
});

test("verifyCheckpointRow applies the full rule: link below the final head, window for a missing epoch, empty root at size 0, integers", async () => {
  const a = pair();
  const b = pair();
  const { env, db, vars } = setup(a.secret);
  grow(db, 1);
  await makeCheckpoints(env); // identity at size 1
  grow(db, 2);
  grow(db, 3);
  await makeCheckpoints(env); // identity at size 3: the final head
  vars.REGISTRY_SEED_NEXT = b.secret;
  const r = (await rotateRegistryKey(env)) as Record<string, any>;
  const rows = (await readRegistryKeyHistory(env)).rows;
  const small = heads(db).find((h) => h.log === IDENTITY && h.tree_size === 1)!;
  const below = await verifyCheckpointRow(rows, small);
  assert.equal(below.ok, false, "below the final head with no link");
  assert.match(below.reason ?? "", /consistency proof/);
  const firstEvent = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1").get() as { id: number }).id;
  const p = (await inclusion(env, IDENTITY, String(firstEvent))) as Record<string, any>;
  assert.deepEqual(await verifyCheckpointRow(rows, small, { proof: p.final_consistency.proof }), { ok: true }, "with the served link");
  assert.equal((await verifyCheckpointRow(rows, small, { proof: [] })).ok, false, "an empty link does not do");
  // A size-0 head under the retired key with any other root than the empty tree's.
  const at = r.activated_at - 1;
  const zero = { log: "ledger", tree_size: 0, root: "7".repeat(64), created_at: at, key_epoch: 0, sig: await signWithSeed(a.seed, checkpointPayload("ledger", 0, "7".repeat(64), at)) };
  assert.equal((await verifyCheckpointRow(rows, zero, { proof: [] })).ok, false);
  // No key_epoch: the epoch whose window holds the date.
  grow(db, 4);
  await makeCheckpoints(env);
  const fresh = heads(db).filter((h) => h.key_epoch === 1).at(-1)!;
  const { key_epoch: _e, ...bare } = fresh;
  assert.deepEqual(await verifyCheckpointRow(rows, bare), { ok: true }, "a new-key head without key_epoch is found by its date");
  assert.equal((await verifyCheckpointRow(rows, { ...fresh, key_epoch: "1" as unknown as number })).ok, false, "a string epoch is refused");
});
