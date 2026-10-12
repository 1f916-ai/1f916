// witness/bin/witness.mjs and a registry key rotation. By default it does not
// follow one: a statement the old key signed proves only that whoever held the
// old key signed it, which a thief with that key can also do, so a rotation is
// recorded as registry-key-rotation-not-followed and nothing is countersigned
// until the operator re-pins. With following turned on (the flag, or the pin
// file's follow_registry_rotation), it follows only through statements BOTH
// keys signed, starting from the key it pinned.
//
// Before this change any key other than the pinned one was a
// refused-registry-key-changed line, with no way to tell a planned change
// from an impostor. Now the checkpoint response carries registry_key_history,
// and the witness walks it as a chain: consecutive epochs, each rotation statement
// exactly "1f916.registry-rotate.v1:<epoch>:<old>:<new>:<at>" with <at> the
// new epoch's activated_at and the old epoch's retired_at, signed by the old
// key and by the new one, the last entry the offered key. The pinned key must
// be in that chain. Each head is verified with the key of its key_epoch, and a
// head naming a retired epoch must be older than the retirement.
//
// Runs the witness as a child against test/helpers/witness-fake-registry.mjs,
// with real Ed25519 keys. Red on main: the rotation tests expect a followed or
// a reported-not-followed rotation where main writes
// refused-registry-key-changed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WITNESS = join(import.meta.dirname, "..", "witness", "bin", "witness.mjs");
const FAKE = pathToFileURL(join(import.meta.dirname, "helpers", "witness-fake-registry.mjs")).href;
const REGISTRY = "http://registry.invalid";
const UTF8 = "utf8";
const PIN_FILE = "registry-key.json";
const LOG_FILE = "countersignatures.jsonl";
const HEADS_FILE = "last-heads.json";
const SCENARIO_FILE = "scenario.json";
const CHANGED = "refused-registry-key-changed";
const NOT_FOLLOWED = "registry-key-rotation-not-followed";
const FOLLOW = ["--follow-registry-rotation", "on"];
const EPOCH_REFUSED = "refused-registry-key-epoch";
const COUNTERSIGNED = "countersigned";
const ROOT = "a".repeat(64);
const T0 = 1789400000000;
const ROTATED_AT = T0 + 1_000_000;

interface Key {
  x: string;
  priv: KeyObject;
}
function key(): Key {
  const kp = generateKeyPairSync("ed25519");
  return { x: (kp.publicKey.export({ format: "jwk" }) as { x: string }).x, priv: kp.privateKey };
}
const signB64u = (k: Key, msg: string) => sign(null, Buffer.from(msg, UTF8), k.priv).toString("base64url");
// The old key's final heads at the rotation: the identity log at size 2, the
// ledger at size 3 (its head below, signed by A, is that final head).
const FINAL = [
  { log: "identity_events", tree_size: 2, root: "a".repeat(64) },
  { log: "ledger", tree_size: 3, root: "a".repeat(64) },
];
const finalText = FINAL.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",");
const statement = (epoch: number, oldX: string, newX: string, at: number) => `1f916.registry-rotate.v1:${epoch}:${oldX}:${newX}:${at}:${finalText}`;

const A = key();
const B = key();
const X = key();
const C = key();

function head(log: string, k: Key, epoch: number | undefined, created: number, size = 3) {
  const payload = `1f916.checkpoint.v1:${log}:${size}:${ROOT}:${created}`;
  return { log, tree_size: size, root: ROOT, created_at: created, sig: signB64u(k, payload), ...(epoch === undefined ? {} : { key_epoch: epoch }) };
}

// The history a registry serves after rotating A -> B, with the signers of
// the statement replaceable so each forgery is one argument.
function history(oldSigner: Key | null = A, newSigner: Key = B, at = ROTATED_AT, statementAt = at) {
  const s = statement(1, A.x, B.x, statementAt);
  return [
    { epoch: 0, public_key: A.x, activated_at: 0, retired_at: at, rotation: null },
    { epoch: 1, public_key: B.x, activated_at: at, retired_at: null, rotation: { statement: s, old_sig: oldSigner ? signB64u(oldSigner, s) : "", new_sig: signB64u(newSigner, s), final_heads: FINAL } },
  ];
}

type Run = { status: number | null; stderr: string; lines: Record<string, any>[]; pin: Record<string, any>; retired: Record<string, any>[] };

const scratch = mkdtempSync(join(tmpdir(), "witness-rotation-"));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;

function readRetired(f: string): Record<string, any>[] {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, UTF8)) : [];
  } catch {
    return [];
  }
}

function run(checkpoint: Record<string, unknown>, pinned: string, extra: string[] = [], pinExtra: Record<string, unknown> = {}, stateName?: string, consistency: Record<string, unknown> = { kind: "throw" }): Run {
  const state = join(scratch, stateName ?? String(++n));
  const fresh = !existsSync(state);
  mkdirSync(state, { recursive: true });
  if (fresh) writeFileSync(join(state, PIN_FILE), JSON.stringify({ registry: REGISTRY, registry_public_key: pinned, first_seen: "then", ...pinExtra }));
  const before = existsSync(join(state, LOG_FILE)) ? readFileSync(join(state, LOG_FILE), UTF8).trim().split("\n").filter(Boolean).length : 0;
  const scenario = join(state, SCENARIO_FILE);
  writeFileSync(scenario, JSON.stringify({ checkpoint, consistency }));
  const r = spawnSync(process.execPath, ["--import", FAKE, WITNESS, "--registry", REGISTRY, "--state", state, ...extra], {
    env: { ...process.env, WITNESS_FAKE: scenario },
    encoding: UTF8,
  });
  const logPath = join(state, LOG_FILE);
  const lines = existsSync(logPath) ? readFileSync(logPath, UTF8).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(before) : [];
  const retiredFile = join(state, "retired-registry-keys.json");
  return { status: r.status, stderr: r.stderr, lines, pin: JSON.parse(readFileSync(join(state, PIN_FILE), UTF8)), retired: readRetired(retiredFile) };
}

// After the rotation: the identity head is new (epoch 1), the ledger head is
// a quiet log's last head from before the rotation (epoch 0). Both are
// legitimate and both must be countersigned.
const rotated = (h = history()) => ({
  registry_public_key: { x: B.x },
  registry_key_history: h,
  checkpoints: [head("identity_events", B, 1, ROTATED_AT + 10), head("ledger", A, 0, ROTATED_AT - 10)],
});

function refusedChange(r: Run, reason: RegExp) {
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].status, CHANGED);
  assert.equal(r.lines[0].pinned, A.x);
  assert.equal(r.lines[0].offered, B.x);
  assert.match(r.lines[0].rotation, reason);
  assert.equal(r.pin.registry_public_key, A.x, "a refused change never moves the pin");
}

test("by default a rotation both keys signed is reported and NOT followed: nothing countersigned, the pin stays", () => {
  const r = run(rotated(), A.x);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].status, NOT_FOLLOWED);
  assert.equal(r.lines[0].pinned, A.x);
  assert.equal(r.lines[0].offered, B.x);
  assert.equal(r.lines[0].registry_key_epoch, 1);
  assert.equal(r.lines[0].rotation_statements[0].statement, statement(1, A.x, B.x, ROTATED_AT));
  assert.equal(r.lines.filter((l) => l.status === COUNTERSIGNED).length, 0);
  assert.equal(r.pin.registry_public_key, A.x, "the pin is the operator's to move");
  assert.match(r.stderr, /Not followed/);
});

test("with following on (the flag), a rotation both keys signed is followed: heads of both epochs countersigned, the pin moves with the statement", () => {
  const r = run(rotated(), A.x, FOLLOW);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.lines.map((l) => [l.log, l.status, l.key_epoch]),
    [
      ["identity_events", COUNTERSIGNED, 1],
      ["ledger", COUNTERSIGNED, 0],
    ],
  );
  assert.equal(r.pin.registry_public_key, B.x);
  assert.equal(r.pin.rotated_from, A.x);
  assert.equal(r.pin.registry_key_epoch, 1);
  assert.equal(r.pin.first_seen, "then", "the original first-use date is kept");
  assert.equal(r.pin.rotation_statements[0].statement, statement(1, A.x, B.x, ROTATED_AT));
  assert.equal(r.lines.every((l) => l.followed_from === A.x), true, "every line says which key it followed from");
});

test("following can be turned on in the pin file instead of the flag, and the setting is kept when the pin moves", () => {
  const r = run(rotated(), A.x, [], { follow_registry_rotation: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines.every((l) => l.status === COUNTERSIGNED), true);
  assert.equal(r.pin.registry_public_key, B.x);
  assert.equal(r.pin.follow_registry_rotation, true);
});

test("a shortened history (oldest epochs left out) is followed from a pinned key inside it, and refused when the pinned key was left out", () => {
  const T2 = ROTATED_AT + 2_000_000;
  const s1 = statement(1, A.x, B.x, ROTATED_AT);
  const s2 = statement(2, B.x, C.x, T2);
  const served = [
    { epoch: 1, public_key: B.x, activated_at: ROTATED_AT, retired_at: T2, rotation: { statement: s1, old_sig: signB64u(A, s1), new_sig: signB64u(B, s1), final_heads: FINAL } },
    { epoch: 2, public_key: C.x, activated_at: T2, retired_at: null, rotation: { statement: s2, old_sig: signB64u(B, s2), new_sig: signB64u(C, s2), final_heads: FINAL } },
  ];
  const cp = { registry_public_key: { x: C.x }, registry_key_history: served, checkpoints: [head("identity_events", C, 2, T2 + 10), head("ledger", B, 1, T2 - 10)] };
  const r = run(cp, B.x, FOLLOW);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.lines.map((l) => [l.status, l.key_epoch]), [[COUNTERSIGNED, 2], [COUNTERSIGNED, 1]]);
  assert.equal(r.pin.registry_key_epoch, 2);
  const lost = run(cp, A.x, FOLLOW);
  assert.equal(lost.status, 1);
  assert.equal(lost.lines[0].status, CHANGED);
  assert.match(lost.lines[0].rotation, /pinned key is not in the served registry_key_history/);
});

test("a rotation WITHOUT the old key's signature is refused: the new key signing for both is not consent", () => {
  refusedChange(run(rotated(history(B, B)), A.x, FOLLOW), /old_sig does not verify/);
});

test("a rotation with the old signature missing altogether is refused", () => {
  refusedChange(run(rotated(history(null, B)), A.x, FOLLOW), /old_sig does not verify/);
});

test("a rotation whose new key did not sign is refused", () => {
  refusedChange(run(rotated(history(A, A)), A.x, FOLLOW), /new_sig does not verify/);
});

test("a statement whose instant is not the served boundary is refused (the signed text must be the one the history implies)", () => {
  refusedChange(run(rotated(history(A, B, ROTATED_AT, ROTATED_AT - 1)), A.x, FOLLOW), /no rotation statement, or not/);
});

test("a valid chain that does not contain the pinned key is refused", () => {
  const r = run(rotated(), X.x, FOLLOW);
  assert.equal(r.status, 1);
  assert.equal(r.lines[0].status, CHANGED);
  assert.match(r.lines[0].rotation, /pinned key is not in the served registry_key_history/);
  assert.equal(r.pin.registry_public_key, X.x);
});

test("a key change with no history at all is refused exactly as before", () => {
  const r = run({ registry_public_key: { x: B.x }, checkpoints: [head("ledger", B, undefined, T0)] }, A.x, FOLLOW);
  refusedChange(r, /no registry_key_history served/);
});

test("a head the retired key signed after its retirement is refused, beside a good head that is countersigned", () => {
  const cp = rotated();
  cp.checkpoints[1] = head("ledger", A, 0, ROTATED_AT + 5);
  const r = run(cp, B.x);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.lines[0].status, COUNTERSIGNED);
  assert.equal(r.lines[1].status, EPOCH_REFUSED);
  assert.match(r.lines[1].detail, /not before epoch 0's retirement/);
  assert.equal(r.lines[1].witness_sig, undefined);
});

test("a head naming the right epoch but signed by another key is still registry_signature_invalid", () => {
  const cp = rotated();
  cp.checkpoints[0] = head("identity_events", A, 1, ROTATED_AT + 10);
  const r = run(cp, B.x);
  assert.equal(r.lines[0].status, "registry_signature_invalid");
});

test("a registry that predates epochs (no history, no key_epoch, key unchanged) is countersigned as before", () => {
  const r = run({ registry_public_key: { x: A.x }, checkpoints: [head("ledger", A, undefined, T0)] }, A.x);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines[0].status, COUNTERSIGNED);
  assert.equal(r.lines[0].key_epoch, undefined);
  assert.equal(existsSync(join(scratch, String(n), HEADS_FILE)), true);
});

test("a pin given on the command line follows the rotation for the run but is not rewritten", () => {
  const r = run(rotated(), X.x, ["--registry-key", A.x, ...FOLLOW]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.pin.registry_public_key, X.x, "the pin file is the operator's when --registry-key is used");
});

test("a head that names no key_epoch is epoch 0: after a re-pin, a quiet log's pre-epoch head is still countersigned", () => {
  const cp = rotated();
  cp.checkpoints[1] = head("ledger", A, undefined, ROTATED_AT - 10);
  const r = run(cp, B.x);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.lines.map((l) => [l.log, l.status]), [["identity_events", COUNTERSIGNED], ["ledger", COUNTERSIGNED]]);
});

test("a history whose numbers are strings is refused even with following on: the signatures still verify, and a string retirement would never retire", () => {
  const strings = history().map((h) => ({ ...h, activated_at: String(h.activated_at), retired_at: h.retired_at === null ? null : String(h.retired_at) }));
  const cp = { ...rotated(strings as unknown as ReturnType<typeof history>), checkpoints: [head("ledger", A, 0, ROTATED_AT + 5)] };
  refusedChange(run(cp, A.x, FOLLOW), /activated_at is not an integer/);
});

test("a holder of the retired key cannot extend a log: a head past the committed final head is refused, whatever its date", () => {
  const cp = rotated();
  cp.checkpoints[1] = head("ledger", A, 0, ROTATED_AT - 1, 5);
  const r = run(cp, B.x);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.lines[1].status, EPOCH_REFUSED);
  assert.match(r.lines[1].detail, /goes past what both keys committed to/);
});

test("a log never goes back to an older key once a newer one was countersigned", () => {
  const first = run({ ...rotated(), checkpoints: [head("ledger", B, 1, ROTATED_AT + 20, 3)] }, B.x, [], {}, "regress");
  assert.equal(first.status, 0, first.stderr);
  const second = run({ ...rotated(), checkpoints: [head("ledger", A, 0, ROTATED_AT - 10, 3)] }, B.x, [], {}, "regress");
  assert.equal(second.status, 1);
  assert.equal(second.lines[0].status, EPOCH_REFUSED);
  assert.match(second.lines[0].detail, /older than epoch 1/);
});

test("a witness that did not follow remembers the retirement, and refuses the retired key offered as active again", () => {
  const first = run(rotated(), A.x, [], {}, "remember");
  assert.equal(first.lines[0].status, NOT_FOLLOWED);
  assert.equal(first.retired[0].public_key, A.x);
  assert.equal(first.retired[0].retired_at, ROTATED_AT);
  assert.deepEqual(first.retired[0].final_heads, FINAL);
  // What a holder of A would serve: A as the active key, no history at all.
  const second = run({ registry_public_key: { x: A.x }, checkpoints: [head("ledger", A, undefined, ROTATED_AT - 1, 9)] }, A.x, [], {}, "remember");
  assert.equal(second.status, 1);
  assert.equal(second.lines[0].status, "refused-registry-key-retired");
});

test("the retirement is remembered when the key is pinned on the command line, followed or not", () => {
  const thief = { registry_public_key: { x: A.x }, checkpoints: [head("ledger", A, undefined, ROTATED_AT - 1, 9)] };
  const cli = ["--registry-key", A.x];
  const seen = run(rotated(), A.x, cli, {}, "cli");
  assert.equal(seen.lines[0].status, NOT_FOLLOWED);
  assert.equal(seen.retired[0].public_key, A.x);
  const again = run(thief, A.x, cli, {}, "cli");
  assert.equal(again.status, 1);
  assert.equal(again.lines[0].status, "refused-registry-key-retired");
  const followed = run(rotated(), A.x, [...cli, ...FOLLOW], {}, "cli-follow");
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(followed.retired[0].public_key, A.x, "the key it followed from is retired too");
  const after = run(thief, A.x, [...cli, ...FOLLOW], {}, "cli-follow");
  assert.equal(after.status, 1);
  assert.equal(after.lines[0].status, "refused-registry-key-retired");
});

test("a log whose last countersignature named an epoch never takes a head that names none", () => {
  const first = run({ ...rotated(), checkpoints: [head("ledger", B, 1, ROTATED_AT + 20, 3)] }, B.x, [], {}, "noepoch");
  assert.equal(first.status, 0, first.stderr);
  const second = run({ ...rotated(), checkpoints: [head("ledger", B, undefined, ROTATED_AT + 30, 4)] }, B.x, [], {}, "noepoch");
  assert.equal(second.status, 1);
  assert.equal(second.lines[0].status, EPOCH_REFUSED);
  assert.match(second.lines[0].detail, /names no key_epoch/);
});

test("a registry whose heads name no key_epoch is countersigned run after run: an epoch the witness placed by date is not one the registry named", () => {
  const cp = { ...rotated(), checkpoints: [head("ledger", B, undefined, ROTATED_AT + 20, 3)] };
  const first = run(cp, B.x, [], {}, "unnamed");
  assert.equal(first.status, 0, first.stderr);
  // The same head again: the consistency proof between equal sizes is empty.
  const second = run(cp, B.x, [], {}, "unnamed", { kind: "json", status: 200, body: { proof: [] } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.lines[0].status, COUNTERSIGNED);
});

test("a state file the witness cannot read stops the run with one line naming it, not a stack trace", () => {
  const state = join(scratch, "corrupt");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, PIN_FILE), JSON.stringify({ registry: REGISTRY, registry_public_key: B.x, first_seen: "then" }));
  writeFileSync(join(state, "retired-registry-keys.json"), "{not json");
  const r = run(rotated(), B.x, [], {}, "corrupt");
  assert.equal(r.status, 2);
  assert.equal(r.lines.length, 0, "nothing recorded");
  assert.match(r.stderr, /retired-registry-keys\.json could not be read/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

test("followed_from rides only while the pin is the one following moved it to", () => {
  const followed = run(rotated(), A.x, FOLLOW, {}, "followed-from");
  assert.equal(followed.lines.every((l) => l.followed_from === A.x), true);
  const cli = run(rotated(), A.x, ["--registry-key", B.x], {}, "followed-from", { kind: "json", status: 200, body: { proof: [] } });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.lines.every((l) => l.followed_from === undefined), true, "a pin given on the command line is a choice, not a followed rotation");
  writeFileSync(join(scratch, "followed-from", PIN_FILE), JSON.stringify({ registry: REGISTRY, registry_public_key: B.x, first_seen: "re-pinned by hand" }));
  const repinned = run(rotated(), B.x, [], {}, "followed-from", { kind: "json", status: 200, body: { proof: [] } });
  assert.equal(repinned.status, 0, repinned.stderr);
  assert.equal(repinned.lines.every((l) => l.followed_from === undefined), true);
});
