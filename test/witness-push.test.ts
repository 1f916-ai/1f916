// The registry's half of the witness push (src/witness-push.ts): a witness
// POSTs the countersignature row it already published, and the registry keeps
// the newest per (witness, log) behind a receipt it signs.
//
// The signatures are real Ed25519 ones made with node:crypto over the preimage
// witness/bin/witness.mjs builds, so a wrong key, origin or size is refused for
// the reason its rule names and not because a stub said so.
//
// Mutations that must turn a named test red:
//   - skip the signature check (rule 3): the "does not verify" cases, red.
//   - match the checkpoint on tree_size alone (rule 4): the wrong-root case, red.
//   - re-sign on a repeat instead of returning the stored receipt: the dedup
//     test, which pins the stored received_at to 1, red.
//   - drop the WHERE from the upsert: the race test stores a smaller row over
//     the larger one, red.
//   - store an older row: the older-row test sees the table change, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { WITNESS_RECEIPT_PAYLOAD_PREFIX, acceptCountersignature, lagSeconds, latestCountersignatures } from "../src/witness-push.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x as string, "base64url");
// A 64-hex root that differs per size, so a wrong root is a different string.
const rootOf = (n: number) => n.toString(16).padStart(64, "0");

function registryKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { pub: Buffer.from(pub), secret: `${b64u(seed)}.${b64u(pub)}` };
}

function witnessKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: b64u(rawPublic(publicKey)), privateKey };
}

// What witness.mjs signs for one checkpoint, for the registry at `origin`.
const countersign = (k: { privateKey: KeyObject }, log: string, size: number, root: string, origin = ORIGIN) =>
  b64u(edSign(null, Buffer.from(`1f916.witness.v1:${origin}:${log}:${size}:${root}`, "utf8"), k.privateKey));

function fixture() {
  const { env, db, d1 } = sqliteTestEnv(SCHEMA);
  const reg = registryKey();
  const e = { ...env, REGISTRY_SEED: reg.secret } as Env;
  const key = witnessKey();
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)");
  // Witness 1 holds a key and is on epoch 2; witness 2 has none.
  db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, added_at, epoch) VALUES (1, 1, 'w1', 'https://w1.example/witness', ?, 0, 2)").run(key.pub);
  db.exec("INSERT INTO witnesses (id, citizen_id, name, url, public_key, added_at) VALUES (2, 1, 'keyless', 'https://w2.example/witness', NULL, 0)");
  // A registry checkpoint at a size, returning its id. The root is rootOf(size).
  const stamp = (log: string, size: number, createdAt: number) =>
    Number(db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, ?, ?, 'sig', ?)").run(log, size, rootOf(size), createdAt).lastInsertRowid);
  // The body a witness would POST for the checkpoint at (log, size).
  const row = (log: string, size: number) => ({ log, tree_size: size, root: rootOf(size), witness_sig: countersign(key, log, size, rootOf(size)) });
  const push = (body: unknown, witnessId = 1) => acceptCountersignature(e, witnessId, body, ORIGIN);
  const stored = () => (db.prepare("SELECT * FROM witness_countersignatures ORDER BY witness_id, log").all() as Record<string, unknown>[]).map((r) => ({ ...r }));
  return { e, db, d1, reg, key, stamp, row, push, stored };
}

test("rule 1: anything but exactly log, tree_size, root and witness_sig is a 400, and nothing is stored", async () => {
  const { push, row, stamp, stored } = fixture();
  stamp("ledger", 3, 1000);
  const good = row("ledger", 3);
  const bad: [string, unknown][] = [
    ["null", null],
    ["an array", [good]],
    ["a string", "ledger"],
    ["an empty object", {}],
    ["a missing field", { log: good.log, tree_size: good.tree_size, root: good.root }],
    ["an extra field", { ...good, note: "x" }],
    ["an unknown log", { ...good, log: "posts" }],
    ["tree_size zero", { ...good, tree_size: 0 }],
    ["tree_size negative", { ...good, tree_size: -3 }],
    ["tree_size fractional", { ...good, tree_size: 3.5 }],
    ["tree_size as a string", { ...good, tree_size: "3" }],
    ["tree_size past the safe integers", { ...good, tree_size: 2 ** 60 }],
    ["root in upper case", { ...good, root: "A".repeat(64) }],
    ["root too short", { ...good, root: good.root.slice(1) }],
    ["witness_sig too short", { ...good, witness_sig: good.witness_sig.slice(1) }],
    ["witness_sig padded", { ...good, witness_sig: `${good.witness_sig.slice(1)}==` }],
    ["witness_sig in hex", { ...good, witness_sig: "ab".repeat(64) }],
  ];
  for (const [name, body] of bad) {
    const r = await push(body);
    assert.equal(r.status, 400, name);
    assert.equal(typeof r.body.error, "string", name);
    assert.equal(typeof r.body.note, "string", name);
  }
  assert.deepEqual(stored(), []);
  assert.equal((await push(good)).status, 201, "the same shape, well formed, is accepted");
});

test("rule 2: an unknown witness is a 404 and a witness with no key is a 409", async () => {
  const { push, row, stamp } = fixture();
  stamp("ledger", 3, 1000);
  assert.equal((await push(row("ledger", 3), 99)).status, 404);
  const keyless = await push(row("ledger", 3), 2);
  assert.equal(keyless.status, 409);
  assert.match(String(keyless.body.error), /no key/);
});

test("rule 3: a signature that does not verify over the witness.v1 preimage for this origin is a 422", async () => {
  const { push, row, stamp, stored, key } = fixture();
  stamp("ledger", 3, 1000);
  stamp("ledger", 4, 2000);
  const good = row("ledger", 3);
  const cases: [string, string][] = [
    ["signed by another key", countersign(witnessKey(), "ledger", 3, good.root)],
    ["signed for another registry", countersign(key, "ledger", 3, good.root, "https://staging.example")],
    ["signed with a trailing slash on the origin", countersign(key, "ledger", 3, good.root, `${ORIGIN}/`)],
    ["signed for another tree_size", countersign(key, "ledger", 4, rootOf(4))],
    ["signed for another log", countersign(key, "identity_events", 3, good.root)],
  ];
  for (const [name, witness_sig] of cases) {
    const r = await push({ ...good, witness_sig });
    assert.equal(r.status, 422, name);
    assert.match(String(r.body.error), /does not verify/, name);
  }
  assert.deepEqual(stored(), []);
});

test("rule 4: a head this registry did not sign is a 422, even under a valid witness signature", async () => {
  const { push, stamp, key, stored } = fixture();
  stamp("ledger", 3, 1000);
  const signed = (log: string, size: number, root: string) => ({ log, tree_size: size, root, witness_sig: countersign(key, log, size, root) });
  // A size no checkpoint has.
  const missing = await push(signed("ledger", 99, rootOf(99)));
  assert.equal(missing.status, 422);
  assert.match(String(missing.body.error), /not a checkpoint this registry signed/);
  // A size a checkpoint has, with a root it does not: the witness signed some other tree.
  assert.equal((await push(signed("ledger", 3, rootOf(1234)))).status, 422);
  // The right size under the other log.
  assert.equal((await push(signed("identity_events", 3, rootOf(3)))).status, 422);
  assert.deepEqual(stored(), []);
});

test("rule 5: the first valid row is stored with a receipt the registry key verifies", async () => {
  const { push, row, stamp, stored, reg } = fixture();
  const checkpointId = stamp("ledger", 3, 1000);
  const body = row("ledger", 3);
  const before = Date.now();
  const r = await push(body);
  const after = Date.now();
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ["accepted", "log", "receipt", "registry_public_key", "tree_size", "witness_id"]);
  assert.equal(r.body.accepted, true);
  assert.deepEqual(r.body.registry_public_key, { kty: "OKP", crv: "Ed25519", x: b64u(reg.pub) });
  const receipt = r.body.receipt as { payload: string; sig: string };
  // origin, witness id, the witness's CURRENT epoch, then log, size, root, received_at.
  const head = `${WITNESS_RECEIPT_PAYLOAD_PREFIX}:${ORIGIN}:1:2:ledger:3:${rootOf(3)}:`;
  assert.ok(receipt.payload.startsWith(head), receipt.payload);
  const receivedAt = Number(receipt.payload.slice(head.length));
  assert.ok(Number.isInteger(receivedAt) && receivedAt >= before && receivedAt <= after, "received_at is Date.now() in milliseconds, as checkpoints.created_at is");
  const registryKeyObject = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(reg.pub) }, format: "jwk" });
  assert.ok(edVerify(null, Buffer.from(receipt.payload, "utf8"), registryKeyObject, Buffer.from(receipt.sig, "base64url")), "the receipt verifies under the registry key");
  assert.deepEqual(stored(), [
    {
      witness_id: 1,
      log: "ledger",
      tree_size: 3,
      root: rootOf(3),
      witness_sig: body.witness_sig,
      witness_epoch: 2,
      checkpoint_id: checkpointId,
      received_at: receivedAt,
      receipt_payload: receipt.payload,
      receipt_sig: receipt.sig,
    },
  ]);
});

test("rule 5: the same row again is answered from the stored receipt, not signed anew", async () => {
  const { push, row, stamp, stored, db } = fixture();
  stamp("ledger", 3, 1000);
  assert.equal((await push(row("ledger", 3))).status, 201);
  // Pin the stored receipt to values no signer here would produce: a repeat that re-signed would answer with the current time instead.
  db.exec("UPDATE witness_countersignatures SET received_at = 1, receipt_payload = 'stored-payload', receipt_sig = 'stored-sig'");
  const again = await push(row("ledger", 3));
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { accepted: true, deduplicated: true, receipt: { payload: "stored-payload", sig: "stored-sig" } });
  assert.equal(stored().length, 1);
  assert.equal(stored()[0].received_at, 1);
});

test("rule 5: an older row than the stored one is a 200 accepted:false and nothing changes", async () => {
  const { push, row, stamp, stored } = fixture();
  stamp("ledger", 3, 1000);
  stamp("ledger", 5, 2000);
  assert.equal((await push(row("ledger", 5))).status, 201);
  const snapshot = stored();
  const older = await push(row("ledger", 3));
  assert.equal(older.status, 200);
  assert.equal(older.body.accepted, false);
  assert.match(String(older.body.reason), /tree_size 5/);
  assert.ok(!("receipt" in older.body), "no receipt for a row that was not stored");
  assert.deepEqual(stored(), snapshot);
});

test("rule 5: a larger row replaces the stored one in place, and each log keeps its own row", async () => {
  const { push, row, stamp, stored } = fixture();
  stamp("ledger", 3, 1000);
  const id5 = stamp("ledger", 5, 2000);
  stamp("identity_events", 2, 1500);
  const first = await push(row("ledger", 3));
  const second = await push(row("ledger", 5));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.body.tree_size, 5);
  assert.equal((await push(row("identity_events", 2))).status, 201);
  const rows = stored();
  assert.deepEqual(rows.map((r) => [r.log, r.tree_size]), [["identity_events", 2], ["ledger", 5]]);
  assert.equal(rows[1].checkpoint_id, id5);
  assert.equal(rows[1].receipt_payload, (second.body.receipt as { payload: string }).payload);
  assert.notEqual((first.body.receipt as { payload: string }).payload, (second.body.receipt as { payload: string }).payload);
});

test("rule 5: a larger row that lands between the read and the write wins, and the answer is the older-row one", async () => {
  const { e, db, d1, stamp, row, stored } = fixture();
  stamp("ledger", 3, 1000);
  const id9 = stamp("ledger", 9, 3000);
  let raced = false;
  // The conditional upsert is the first statement that names the table in an INSERT; a concurrent request stores size 9 just before it runs.
  const racing = {
    ...e,
    DB: {
      prepare(sql: string) {
        if (!raced && sql.includes("INSERT INTO witness_countersignatures")) {
          raced = true;
          db.prepare("INSERT INTO witness_countersignatures (witness_id, log, tree_size, root, witness_sig, witness_epoch, checkpoint_id, received_at, receipt_payload, receipt_sig) VALUES (1, 'ledger', 9, ?, 'w', 2, ?, 7, 'p', 's')").run(rootOf(9), id9);
        }
        return d1.prepare(sql);
      },
    },
  } as unknown as Env;
  const r = await acceptCountersignature(racing, 1, row("ledger", 3), ORIGIN);
  assert.ok(raced, "the race was staged");
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, false);
  assert.deepEqual(stored().map((s) => s.tree_size), [9], "the larger row was kept");
});

test("latestCountersignatures: every requested id is present, rows are shaped for the directory, and a long page is chunked", async () => {
  const { e, push, row, stamp } = fixture();
  stamp("ledger", 3, 1000);
  stamp("identity_events", 2, 1500);
  const ledger = row("ledger", 3);
  await push(ledger);
  await push(row("identity_events", 2));
  assert.equal((await latestCountersignatures(e, [])).size, 0);
  const got = await latestCountersignatures(e, [1, 2, 3]);
  assert.deepEqual([...got.keys()], [1, 2, 3]);
  assert.deepEqual(got.get(2), {}, "a witness that never pushed");
  assert.deepEqual(got.get(3), {}, "an id with no witness at all");
  const mine = got.get(1)!;
  assert.deepEqual(Object.keys(mine).sort(), ["identity_events", "ledger"]);
  const l = mine.ledger!;
  assert.deepEqual(Object.keys(l).sort(), ["checkpoint_id", "receipt", "received_at", "root", "tree_size", "witness_epoch", "witness_sig"]);
  assert.equal(l.tree_size, 3);
  assert.equal(l.root, rootOf(3));
  assert.equal(l.witness_sig, ledger.witness_sig);
  assert.equal(l.witness_epoch, 2);
  assert.equal(typeof l.checkpoint_id, "number");
  assert.equal(typeof l.received_at, "number");
  assert.ok(l.receipt.payload.startsWith(WITNESS_RECEIPT_PAYLOAD_PREFIX));
  assert.equal(typeof l.receipt.sig, "string");
  const many = await latestCountersignatures(e, Array.from({ length: 120 }, (_, i) => i + 1));
  assert.equal(many.size, 120);
  assert.equal(many.get(1)!.ledger!.tree_size, 3, "a row in the first chunk");
  assert.deepEqual(many.get(120), {}, "an id in the last chunk");
});

test("lagSeconds: a quiet log is 0, a newer checkpoint is the seconds since the oldest one past the size", async () => {
  const { e, stamp } = fixture();
  stamp("ledger", 3, 1_000_000);
  stamp("ledger", 5, 1_060_000);
  stamp("ledger", 7, 1_120_000);
  stamp("identity_events", 9, 500_000);
  const later = 9_000_000;
  assert.equal(await lagSeconds(e, "ledger", 7, later), 0, "holding the newest head");
  assert.equal(await lagSeconds(e, "ledger", 8, later), 0, "past the newest head");
  assert.equal(await lagSeconds(e, "identity_events", 9, later), 0, "a log with one stamp, held");
  assert.equal(await lagSeconds(e, "ledger", 3, 1_200_000), 140, "size 5 is the oldest past 3: (1,200,000 - 1,060,000) ms");
  assert.equal(await lagSeconds(e, "ledger", 4, 1_200_000), 140, "a size between stamps counts from the next stamp");
  assert.equal(await lagSeconds(e, "ledger", 0, 1_200_000), 200);
  assert.equal(await lagSeconds(e, "ledger", 3, 1_061_999), 1, "floored to whole seconds");
  assert.equal(await lagSeconds(e, "ledger", 3, 1_000_000), 0, "a clock behind the stamp is never negative");
  assert.equal(await lagSeconds(e, "identity_events", 3, 1_000_000), 500, "each log is read on its own");
});
