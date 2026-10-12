// After a registry key rotation, what the registry serves still verifies with
// the protocol's own offline checker, vendor/protocol/verify.mjs.
//
// A verifier that checks every head with registry_public_key alone reports
// three true things as forgeries once the key has rotated: a saved
// GET /api/checkpoint where a quiet log keeps its head from before the
// rotation, every inclusion proof answered against a head from before the
// rotation (the smallest head covering an old event is one of those, for
// good), and a dossier served after the rotation and before the identity log
// is stamped again (signed by the new key, carrying a head the old key
// signed). Each is produced here by the Worker's own functions after a real
// rotation, saved to a file exactly as served, and handed to verify.mjs with
// the registry key pinned. Every run must come back verified against the
// pinned key (consistent-unwitnessed: no witness file is passed).
//
// Red before the vendored verify.mjs learned key epochs (SPEC section 8b):
// all three read diverged.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { repoAssets } from "./helpers/repo-assets.ts";
import { latestCheckpoints, makeCheckpoints, inclusion } from "../src/checkpoint.ts";
import { rotateRegistryKey } from "../src/registry-keys.ts";
import { record, PUBLISHED_REGISTRY_KEY } from "../src/record.ts";

const FULL_SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const VERIFY = join(import.meta.dirname, "..", "vendor", "protocol", "verify.mjs");
const IDENTITY = "identity_events";

function pair() {
  const kp = generateKeyPairSync("ed25519");
  const der = kp.privateKey.export({ format: "der", type: "pkcs8" });
  const pub = (kp.publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { secret: `${Buffer.from(der.subarray(der.length - 32)).toString("base64url")}.${pub}`, pub };
}

const scratch = mkdtempSync(join(tmpdir(), "rotation-verify-"));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));

function save(name: string, body: unknown): string {
  const f = join(scratch, name);
  writeFileSync(f, JSON.stringify(body));
  return f;
}

// The checker runs as a reader would run it: a plain node process, none of the
// suite's import hooks.
function verify(args: string[]): { verdict: string | undefined; text: string } {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  let text = "";
  try {
    text = execFileSync(process.execPath, [VERIFY, ...args], { encoding: "utf8", env });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    text = (err.stdout ?? "") + (err.stderr ?? "");
  }
  return { verdict: (text.match(/VERDICT: (\S+)/) ?? [])[1], text };
}

const a = pair();
const b = pair();
const { env, db } = sqliteTestEnv(FULL_SCHEMA);
db.exec(`INSERT INTO citizens (id, handle, model, karma, created_at, secret_hash, last_seen_at) VALUES (1,'maintainer','m',0,0,'x',0),(2,'alice','m',0,0,'y',0);`);
const vars = env as unknown as Record<string, unknown>;
vars.ASSETS = repoAssets();
vars.REGISTRY_SEED = a.secret;
const seal = (n: number) =>
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (2, 'test', NULL, ?, NULL, ?)").run(n, `${n}`.padStart(64, "0"));
// Two stamps before the rotation: the first event's smallest covering head
// (size 1) sits below the old key's final head (size 3).
seal(1);
await makeCheckpoints(env);
seal(2);
seal(3);
await makeCheckpoints(env);
vars.REGISTRY_SEED_NEXT = b.secret;
await rotateRegistryKey(env);

// Between the rotation and the next identity stamp: the dossier is signed by
// the new key and carries the identity head the old key signed.
const dossier = save("record.json", await record(env, "alice"));
await makeCheckpoints(env);
const checkpoint = save("checkpoint.json", await latestCheckpoints(env));
const firstEvent = (db.prepare("SELECT id FROM identity_events ORDER BY id LIMIT 1").get() as { id: number }).id;
const proof = save("proof.json", await inclusion(env, IDENTITY, String(firstEvent)));

test("the files are the three shapes that need more than one key", () => {
  const cp = JSON.parse(readFileSync(checkpoint, "utf8"));
  assert.deepEqual(
    cp.checkpoints.map((h: { log: string; key_epoch: number }) => [h.log, h.key_epoch]),
    [
      [IDENTITY, 1],
      ["ledger", 0],
    ],
    "the quiet ledger keeps its head from before the rotation",
  );
  const p = JSON.parse(readFileSync(proof, "utf8"));
  assert.equal(p.checkpoint.key_epoch, 0, "the old event is proved under a head from before the rotation");
  assert.ok(p.final_consistency, "below the old key's final head, so the link to it rides beside the proof");
  const d = JSON.parse(readFileSync(dossier, "utf8"));
  assert.deepEqual([d.registry_sig.key_epoch, d.checkpoint_key_epoch], [1, 0], "the dossier: new key, old head");
});

test("a saved GET /api/checkpoint verifies with the new key pinned, and with the old key pinned it says it followed the rotation", () => {
  const direct = verify(["--checkpoint", checkpoint, "--registry-key", b.pub]);
  assert.equal(direct.verdict, "consistent-unwitnessed", direct.text);
  const followed = verify(["--checkpoint", checkpoint, "--registry-key", a.pub]);
  assert.equal(followed.verdict, "consistent-unwitnessed-followed", followed.text);
});

test("the dossier's own copy-paste command pins the active key, and verifies with the plain verdict", () => {
  const d = JSON.parse(readFileSync(dossier, "utf8"));
  const pin = (d.verify_offline.match(/--registry-key (\S+)/) ?? [])[1];
  assert.equal(pin, b.pub, "after the rotation, the active key, never the retired published one");
  assert.notEqual(pin, PUBLISHED_REGISTRY_KEY);
  const r = verify(["--dossier", dossier, "--registry-key", pin]);
  assert.equal(r.verdict, "consistent-unwitnessed", r.text);
});

test("an inclusion proof answered against a head from before the rotation verifies", () => {
  const alone = verify(["--checkpoint", proof, "--inclusion", proof, "--registry-key", b.pub]);
  assert.equal(alone.verdict, "consistent-unwitnessed", alone.text);
  const beside = verify(["--checkpoint", checkpoint, "--inclusion", proof, "--registry-key", b.pub]);
  assert.equal(beside.verdict, "consistent-unwitnessed", beside.text);
});

test("a dossier served between the rotation and the next identity stamp verifies", () => {
  const r = verify(["--dossier", dossier, "--registry-key", b.pub]);
  assert.equal(r.verdict, "consistent-unwitnessed", r.text);
  assert.match(r.text, /PASS {2}registry signature {2}identity_events size=\d+ {2}\[key epoch 0\]/);
});

test("a key the history does not reach is still refused", () => {
  const r = verify(["--checkpoint", checkpoint, "--registry-key", pair().pub]);
  assert.equal(r.verdict, "diverged", r.text);
});
