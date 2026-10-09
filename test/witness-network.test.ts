// The stamping job's half of the witness protocol (src/witness-network.ts):
// configured witnesses are handed each new note, verified cosignatures are kept
// and served, and nothing at all happens when none is configured.
//
// The witness below is written from the two specifications (C2SP tlog-witness
// and tlog-cosignature) with node:crypto, the same way test/tlog-witness.test.ts
// writes its own, and it checks the registry's signature and every consistency
// proof it is sent. It keeps one size per origin, as a real witness does.
//
// Killing mutations, each checked in a scratch copy before commit:
//   - always add the witness fields to GET /api/checkpoint: the inert test, red.
//   - send lastCosignedSize 0 every time: the second round asks a witness at
//     size 3 with "old 0" and has to retry; the one-request assertion, red.
//   - keep a line that did not verify (beside one that did): the forged line
//     is served and fails verification, red.
//   - drop the wait after a failure: the back-off test sees a request, red.
//   - drop the prune: the growth test counts more than COSIGNATURES_KEPT, red.
//   - serve the note without the cosignature lines: two tests, red.
//   - send the request without a deadline: the cron test sees no signal, red.
//   - serve every stored line, configured or not: the removed-witness test, red.
//   - match the configuration by name only: the changed-key case, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import { verifyConsistency } from "../src/merkle.ts";
import { checkpointBody, noteFromField, originOf, parseNote, verifyNote, NOTE_KEY_NAME } from "../src/note.ts";
import { checkpointNote, makeCheckpoints } from "../src/checkpoint.ts";
import { parseWitnessVkey, verifyCosignatureV1, type SubmitArgs } from "../src/tlog-witness.ts";
import { COSIGNATURES_KEPT, MAX_WITNESSES, RETRY_AFTER_FAILURE_MS, cosignCheckpoints, readWitnessConfig } from "../src/witness-network.ts";
import { sealMemory, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const CHECKPOINT_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/checkpoint.json", import.meta.url)), "utf8"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x as string, "base64url");
const WITNESS_URL = "https://witness.example/w1";

function registryKey() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return { pub: Buffer.from(pub), secret: `${b64u(seed)}.${b64u(pub)}` };
}

class FakeWitness {
  readonly name: string;
  private readonly keys = generateKeyPairSync("ed25519");
  private readonly logPub: KeyObject;
  readonly logs = new Map<string, { size: number; rootHex: string }>();
  now = Math.floor(Date.now() / 1000) - 1;
  requests: string[] = [];
  // Overrides for one test: a fixed status, or a body in place of the signature.
  status: number | null = null;
  forge: ((body: string) => string) | null = null;
  extra: (body: string) => string[] = () => [];
  constructor(registryPub: Buffer, name = "witness.example/w1") {
    this.name = name;
    this.logPub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64u(registryPub) }, format: "jwk" });
  }
  get pub(): Buffer {
    return rawPublic(this.keys.publicKey);
  }
  vkey(): string {
    const id = sha(Buffer.concat([Buffer.from(this.name + "\n"), Buffer.from([0x04]), this.pub])).subarray(0, 4);
    return `${this.name}+${id.toString("hex")}+${Buffer.concat([Buffer.from([0x04]), this.pub]).toString("base64")}`;
  }
  cosign(body: string, keys: { privateKey: KeyObject } = this.keys): string {
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(this.now));
    const sig = edSign(null, Buffer.from(`cosignature/v1\ntime ${this.now}\n${body}`, "utf8"), keys.privateKey);
    const id = sha(Buffer.concat([Buffer.from(this.name + "\n"), Buffer.from([0x04]), this.pub])).subarray(0, 4);
    return `— ${this.name} ${Buffer.concat([id, ts, sig]).toString("base64")}`;
  }
  async handle(request: string): Promise<{ status: number; text: string }> {
    this.requests.push(request);
    if (this.status !== null) return { status: this.status, text: "unavailable\n" };
    const firstBlank = request.indexOf("\n\n");
    const head = request.slice(0, firstBlank).split("\n");
    const note = request.slice(firstBlank + 2);
    const old = head[0].match(/^old (0|[1-9][0-9]*)$/);
    if (!old) return { status: 400, text: "no old size line\n" };
    const oldSize = Number(old[1]);
    const proof = head.slice(1).map((l) => Buffer.from(l, "base64").toString("hex"));
    const split = note.lastIndexOf("\n\n");
    const body = note.slice(0, split + 1);
    const lines = body.slice(0, -1).split("\n");
    if (lines[0] !== originOf("identity_events") && lines[0] !== originOf("ledger")) return { status: 404, text: "unknown log\n" };
    const logId = sha(Buffer.concat([Buffer.from(NOTE_KEY_NAME + "\n"), Buffer.from([0x01]), rawPublic(this.logPub)])).subarray(0, 4);
    const signed = note
      .slice(split + 2)
      .split("\n")
      .filter(Boolean)
      .some((l) => {
        const m = l.match(/^— (\S+) (\S+)$/);
        if (!m || m[1] !== NOTE_KEY_NAME) return false;
        const raw = Buffer.from(m[2], "base64");
        return raw.length === 68 && raw.subarray(0, 4).equals(logId) && edVerify(null, Buffer.from(body, "utf8"), this.logPub, raw.subarray(4));
      });
    if (!signed) return { status: 403, text: "no trusted signature\n" };
    const held = this.logs.get(lines[0]) ?? { size: 0, rootHex: "" };
    const size = Number(lines[1]);
    const rootHex = Buffer.from(lines[2], "base64").toString("hex");
    if (oldSize > size) return { status: 400, text: "old size is past the checkpoint\n" };
    if (oldSize !== held.size) return { status: 409, text: `${held.size}\n` };
    if (oldSize === 0 && proof.length > 0) return { status: 422, text: "proof with zero old size\n" };
    if (oldSize > 0 && oldSize < size && !(await verifyConsistency(oldSize, size, held.rootHex, rootHex, proof))) return { status: 422, text: "bad consistency proof\n" };
    this.logs.set(lines[0], { size, rootHex });
    return { status: 200, text: [...this.extra(body), this.forge ? this.forge(body) : this.cosign(body)].map((l) => l + "\n").join("") };
  }
  fetchImpl: SubmitArgs["fetchImpl"] = async (url, init) => {
    assert.equal(url, `${WITNESS_URL}/add-checkpoint`);
    const r = await this.handle(init.body);
    return { status: r.status, text: async () => r.text };
  };
}

async function fixture(withWitness = true) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  const key = registryKey();
  const witness = new FakeWitness(key.pub);
  const e = { ...env, REGISTRY_SEED: key.secret, ...(withWitness ? { TLOG_WITNESSES: `${WITNESS_URL} ${witness.vkey()}` } : {}) } as Env;
  const keeper = { id: 1, handle: "keeper" } as Citizen;
  let n = 0;
  const grow = async (count: number) => {
    for (let i = 0; i < count; i++, n++) await sealMemory(e, keeper, { hash: Buffer.from(`seal-${n}`.padEnd(32, ".")).toString("hex"), label: `s${n}` });
  };
  const get = (path: string) => worker.fetch(new Request(`https://1f916.ai${path}`), e);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { env: e, db, key, witness, grow, get, count };
}

const stripClock = (o: Record<string, unknown>) => {
  const { now: _n, now_utc: _u, ...rest } = o;
  return rest;
};
const signatureLines = (note: string) => note.slice(note.lastIndexOf("\n\n") + 2).split("\n").filter(Boolean);

test("unconfigured: nothing is sent, nothing is stored, and the served checkpoint and note are what they were", async () => {
  for (const config of [undefined, "", "   \n  ", "# a comment and nothing else", " ; "]) {
    const { env, db, grow, count } = await fixture(false);
    const e = { ...env, ...(config === undefined ? {} : { TLOG_WITNESSES: config }) } as Env;
    await grow(3);
    await makeCheckpoints(e);
    let asked = 0;
    const summary = await cosignCheckpoints(e, {
      fetchImpl: async () => {
        asked++;
        return { status: 500, text: async () => "" };
      },
    });
    assert.equal(asked, 0);
    assert.deepEqual(summary, { witnesses: 0, attempted: 0, cosigned: 0, failed: 0, config_errors: [] });
    assert.equal(count("SELECT COUNT(*) AS n FROM tlog_witness_state"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 0);
    const get = (path: string) => worker.fetch(new Request(`https://1f916.ai${path}`), e);
    const body = (await (await get("/api/checkpoint")).json()) as Record<string, unknown>;
    for (const k of ["cosignatures", "cosigning_witnesses", "cosignature_format"]) assert.ok(!(k in body), `${k} is absent when nothing is configured`);
    // The keys the response carried before witnesses were wired, in order.
    assert.deepEqual(Object.keys(stripClock(body)), [
      "contract",
      "registry_public_key",
      "witness_dispatch",
      "signed_payload_format",
      "countersignature_payload_format",
      "countersignature_note",
      "checkpoints",
      "note",
      "checkpoint_sequence",
      "leaves_are",
      "tree",
      "how_to_verify",
    ]);
    // The note is the registry's line and nothing else, byte for byte.
    const row = db.prepare("SELECT c.tree_size, c.root, n.signature FROM checkpoints c JOIN checkpoint_notes n ON n.checkpoint_id = c.id WHERE c.log = 'identity_events' ORDER BY c.id DESC LIMIT 1").get() as { tree_size: number; root: string; signature: string };
    const bare = noteFromField(checkpointBody(originOf("identity_events"), row.tree_size, row.root), NOTE_KEY_NAME, row.signature);
    assert.equal(await (await get("/api/checkpoint/note/identity_events")).text(), bare);
  }
});

test("a witness's valid cosignature is kept, served in the JSON and on the note, and verifies there", async () => {
  const { env, witness, grow, get, count, key } = await fixture();
  await grow(3);
  await makeCheckpoints(env);
  const summary = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.deepEqual(summary, { witnesses: 1, attempted: 2, cosigned: 2, failed: 0, config_errors: [] });
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 2, "one per log");

  const served = await (await get("/api/checkpoint/note/identity_events")).text();
  const lines = signatureLines(served);
  assert.equal(lines.length, 2, "the registry's line, then the witness's");
  assert.match(lines[0], new RegExp(`^— ${NOTE_KEY_NAME.replace(".", "\\.")} `));
  const wkey = await parseWitnessVkey(witness.vkey());
  const body = parseNote(served).body;
  assert.ok(await verifyCosignatureV1(lines[1], wkey, body, Date.now()), "the served witness line verifies over the served note");
  const json = (await (await get("/api/checkpoint")).json()) as {
    note: { verifier_key: string };
    cosignatures: { log: string; tree_size: number; witness: string; key_id: string; timestamp: number; line: string }[];
    cosigning_witnesses: { name: string; key_id: string; verifier_key: string; url: string; logs: Record<string, { last_signed_size: number; last_result: string }> }[];
  };
  assert.equal(await verifyNote(served, json.note.verifier_key), true, "the registry's own signature still verifies with the extra line");
  const idLine = json.cosignatures.find((c) => c.log === "identity_events");
  assert.ok(idLine);
  assert.deepEqual({ ...idLine, line: undefined }, { log: "identity_events", tree_size: 3, witness: witness.name, key_id: wkey.keyId, timestamp: witness.now, line: undefined });
  assert.equal(idLine.line, lines[1]);
  assert.equal(json.cosigning_witnesses.length, 1);
  assert.equal(json.cosigning_witnesses[0].verifier_key, witness.vkey());
  assert.equal(json.cosigning_witnesses[0].url, WITNESS_URL);
  assert.equal(json.cosigning_witnesses[0].logs.identity_events.last_signed_size, 3);
  assert.equal(json.cosigning_witnesses[0].logs.identity_events.last_result, "cosigned");
  // The new fields against schemas/checkpoint.json. (Only these: the fixture
  // has no witness_dispatch row, which that block's own tests cover.)
  assert.deepEqual(
    validate(CHECKPOINT_SCHEMA, json).filter((e) => /^\$\.cosign/.test(e)),
    [],
    "the new fields validate",
  );
  assert.ok(validate(CHECKPOINT_SCHEMA, { ...json, cosignatures: [{ ...idLine, key_id: "XYZ" }] }).some((e) => e.startsWith("$.cosignatures")), "and the schema does check them");
  assert.ok(key.pub.length === 32);

  // Nothing new: nobody is asked again.
  witness.requests = [];
  assert.equal((await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() })).attempted, 0);
  assert.equal(witness.requests.length, 0);

  // The log grows: one request, from the size the witness last signed, with a
  // proof the witness checks.
  await grow(4);
  await makeCheckpoints(env);
  const again = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.equal(again.cosigned, 1, "only identity_events grew");
  assert.equal(witness.requests.length, 1);
  assert.match(witness.requests[0], /^old 3\n/);
  const newer = await checkpointNote(env, "identity_events", undefined);
  assert.equal(signatureLines(newer).length, 2);
  assert.equal(parseNote(newer).body.split("\n")[1], "7");
  // The older stamp's note keeps its own cosignature.
  assert.equal(signatureLines(await checkpointNote(env, "identity_events", 3)).length, 2);
});

test("a line that does not verify is never kept", async () => {
  const { env, witness, grow, get, count } = await fixture();
  await grow(2);
  await makeCheckpoints(env);
  const impostor = generateKeyPairSync("ed25519");
  // The witness's name and key id, signed by a different key.
  witness.forge = (body) => witness.cosign(body, impostor);
  const summary = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.equal(summary.cosigned, 0);
  assert.equal(summary.failed, 2);
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 0);
  assert.equal(signatureLines(await (await get("/api/checkpoint/note/identity_events")).text()).length, 1);
  const json = (await (await get("/api/checkpoint")).json()) as { cosignatures: unknown[]; cosigning_witnesses: { logs: Record<string, { last_result: string }> }[] };
  assert.deepEqual(json.cosignatures, [], "configured, none kept: an empty list");
  assert.equal(json.cosigning_witnesses[0].logs.identity_events.last_result, "no-valid-cosignature");
  // A valid line beside a forged one: the valid one is kept, the other is not.
  witness.forge = null;
  witness.extra = (body) => [witness.cosign(body, impostor)];
  const mixed = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() + RETRY_AFTER_FAILURE_MS + 1 });
  assert.equal(mixed.cosigned, 2);
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 2, "one per log, the forged ones dropped");
  assert.equal(signatureLines(await (await get("/api/checkpoint/note/identity_events")).text()).length, 2);
  const kept = (await (await get("/api/checkpoint")).json()) as { cosignatures: { log: string; tree_size: number; line: string }[]; cosigning_witnesses: { logs: Record<string, { last_detail: string }> }[] };
  const wkey = await parseWitnessVkey(witness.vkey());
  assert.equal(kept.cosignatures.length, 2);
  for (const c of kept.cosignatures) assert.ok(await verifyCosignatureV1(c.line, wkey, parseNote(await checkpointNote(env, c.log, c.tree_size)).body, Date.now()), "every served line verifies");
  assert.match(kept.cosigning_witnesses[0].logs.identity_events.last_detail, /1 line\(s\) did not verify/);
  witness.extra = () => [];
  // A line from the future is refused too: grow so there is a new stamp to send.
  await grow(1);
  await makeCheckpoints(env);
  witness.forge = null;
  witness.now = Math.floor(Date.now() / 1000) + 3600;
  const later = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.equal(later.cosigned, 0);
  assert.equal(later.failed, 1);
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 2, "nothing added");
});

test("409: the witness's size is recorded and the request is made once more from it", async () => {
  const { env, witness, grow, db } = await fixture();
  await grow(3);
  await makeCheckpoints(env);
  await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  // This side forgets what the witness holds, as after a restored database.
  db.exec("DELETE FROM tlog_witness_state");
  await grow(2);
  await makeCheckpoints(env);
  witness.requests = [];
  const summary = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.equal(summary.cosigned, 2);
  const idRequests = witness.requests.filter((r) => r.includes(originOf("identity_events")));
  assert.equal(idRequests.length, 2);
  assert.match(idRequests[0], /^old 0\n\n/);
  assert.match(idRequests[1], /^old 3\n/);
  const row = db.prepare("SELECT last_signed_size, last_result FROM tlog_witness_state WHERE log = 'identity_events'").get() as { last_signed_size: number; last_result: string };
  assert.deepEqual({ ...row }, { last_signed_size: 5, last_result: "cosigned" });
});

test("a witness that claims a size past the log: the claim is never stored as signed, and the witness is asked again after the wait", async () => {
  const { env, witness, grow, db } = await fixture();
  await grow(3);
  await makeCheckpoints(env);
  await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  witness.logs.set(originOf("identity_events"), { size: 2 ** 40, rootHex: "" });
  await grow(1);
  await makeCheckpoints(env);
  const t0 = Date.now();
  assert.equal((await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: t0 })).failed, 1);
  const row = db.prepare("SELECT last_signed_size, last_result FROM tlog_witness_state WHERE log = 'identity_events'").get() as { last_signed_size: number; last_result: string };
  assert.equal(row.last_signed_size, 3, "still the last size it cosigned and this side verified");
  assert.notEqual(row.last_result, "cosigned");
  witness.requests = [];
  assert.equal((await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: t0 + 60_000 })).attempted, 0, "within the wait");
  assert.equal((await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: t0 + RETRY_AFTER_FAILURE_MS + 1 })).attempted, 1, "not muted by its own claim");
  assert.ok(witness.requests.length >= 1);
});

test("a witness that is down or times out is a row; the tick goes on and the stamp is untouched", async () => {
  const { env, witness, grow, get, db } = await fixture();
  await grow(2);
  await makeCheckpoints(env);
  const t0 = Date.now();
  const timeout = await cosignCheckpoints(env, {
    fetchImpl: async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
    nowMs: t0,
  });
  assert.deepEqual({ ...timeout, config_errors: undefined }, { witnesses: 1, attempted: 2, cosigned: 0, failed: 2, config_errors: undefined });
  const row = db.prepare("SELECT last_result, last_detail, last_attempt_at, last_ok_at FROM tlog_witness_state WHERE log = 'identity_events'").get() as Record<string, unknown>;
  assert.equal(row.last_result, "network-error");
  assert.match(String(row.last_detail), /timeout/i);
  assert.equal(row.last_attempt_at, t0);
  assert.equal(row.last_ok_at, null);

  // Within the wait, the witness is not asked again; after it, it is.
  witness.status = 503;
  assert.equal((await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: t0 + 60_000 })).attempted, 0);
  assert.equal(witness.requests.length, 0);
  const after = await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: t0 + RETRY_AFTER_FAILURE_MS + 1 });
  assert.equal(after.attempted, 2);
  assert.equal((db.prepare("SELECT last_result FROM tlog_witness_state WHERE log = 'ledger'").get() as { last_result: string }).last_result, "refused:other");

  // Through the Worker's own clock, with the real fetch path: every request
  // carries a deadline, the witness answers 503, and the stamps and the note
  // come out exactly as they would with no witness at all.
  db.exec("DELETE FROM tlog_witness_state");
  await grow(1);
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const signals: unknown[] = [];
  const logged: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith("/add-checkpoint")) signals.push(init?.signal);
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  console.log = (s: string) => void logged.push(String(s));
  try {
    await worker.scheduled!({ cron: "*/5 * * * *", scheduledTime: 0 } as never, env, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  assert.equal(signals.length, 2, "one request per log");
  for (const s of signals) assert.ok(s instanceof AbortSignal, "each request has a deadline");
  assert.ok(logged.some((l) => l.includes('"what":"witness_cosign"') && l.includes('"failed":2')));
  assert.ok(!logged.some((l) => l.includes('"level":"error","what":"checkpoints"')), "the checkpoint pass did not fail");
  const note = await (await get("/api/checkpoint/note/identity_events")).text();
  assert.equal(parseNote(note).body.split("\n")[1], "3", "the stamp landed");
  assert.equal(signatureLines(note).length, 1);
});

test("kept cosignatures are bounded per witness per log", async () => {
  const { env, witness, grow, count, db } = await fixture();
  const rounds = COSIGNATURES_KEPT + 3;
  for (let i = 0; i < rounds; i++) {
    await grow(1);
    await makeCheckpoints(env);
    await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  }
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures WHERE log = 'identity_events'"), COSIGNATURES_KEPT);
  const sizes = (db.prepare("SELECT tree_size FROM checkpoint_cosignatures WHERE log = 'identity_events' ORDER BY tree_size").all() as { tree_size: number }[]).map((r) => r.tree_size);
  assert.deepEqual(sizes, Array.from({ length: COSIGNATURES_KEPT }, (_, i) => rounds - COSIGNATURES_KEPT + 1 + i), "the newest are kept");
  assert.equal(count("SELECT COUNT(*) AS n FROM tlog_witness_state"), 2, "one state row per witness per log");
});

test("the configuration is read strictly, and a bad entry costs only itself", async () => {
  const key = registryKey();
  const ws = Array.from({ length: MAX_WITNESSES + 1 }, (_, i) => new FakeWitness(key.pub, `w${i}.example/w`));
  const lines = [
    "# a comment",
    `${WITNESS_URL}/ ${ws[0].vkey()}`,
    `http://plain.example ${ws[1].vkey()}`,
    `https://user:secret@cred.example ${ws[1].vkey()}`,
    `${WITNESS_URL} not-a-key`,
    `${WITNESS_URL}`,
    `${WITNESS_URL} ${ws[0].vkey()}`,
    ...ws.slice(1).map((w, i) => `https://w${i + 1}.example ${w.vkey()}`),
  ];
  const { witnesses, errors } = await readWitnessConfig({ TLOG_WITNESSES: lines.join("\n") } as unknown as Env);
  assert.equal(witnesses.length, MAX_WITNESSES);
  assert.equal(witnesses[0].url, WITNESS_URL, "a trailing slash is dropped");
  assert.equal(witnesses[0].key.name, ws[0].name);
  assert.equal(errors.length, 6);
  assert.match(errors.join("\n"), /https/);
  assert.ok(errors.some((e) => /credentials/.test(e)) && !errors.join("\n").includes("secret"), "a URL with credentials is refused, and they are not echoed");
  assert.match(errors.join("\n"), /listed twice/);
  assert.match(errors.join("\n"), /more than 5 witnesses/);
  // ';' separates too.
  assert.equal((await readWitnessConfig({ TLOG_WITNESSES: `${WITNESS_URL} ${ws[0].vkey()};https://w1.example ${ws[1].vkey()}` } as unknown as Env)).witnesses.length, 2);
});

test("a witness whose key is ML-DSA-44 (0x06) is refused at configuration, not asked forever", async () => {
  const key = registryKey();
  const ed = new FakeWitness(key.pub, "ed.example/w");
  const name = "mldsa.example/w";
  const pk = new Uint8Array(1312).fill(7);
  const raw = Buffer.concat([Buffer.from([0x06]), Buffer.from(pk)]);
  const id = createHash("sha256").update(Buffer.concat([Buffer.from(name + "\n"), raw])).digest().subarray(0, 4).toString("hex");
  const vkey = `${name}+${id}+${raw.toString("base64")}`;
  assert.equal((await parseWitnessVkey(vkey)).type, 0x06, "the key itself parses");
  const { witnesses, errors } = await readWitnessConfig({ TLOG_WITNESSES: `https://mldsa.example ${vkey}\n${WITNESS_URL} ${ed.vkey()}` } as unknown as Env);
  assert.deepEqual(witnesses.map((w) => w.key.name), [ed.name], "the Ed25519 witness after it is still read");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /0x06/);
  assert.match(errors[0], /mldsa\.example\/w is not asked/);
});

test("only witnesses still in the configuration are served; a removed one, or a changed key under the same name, is not", async () => {
  const { env, witness, grow, count, key } = await fixture();
  await grow(3);
  await makeCheckpoints(env);
  await cosignCheckpoints(env, { fetchImpl: witness.fetchImpl, nowMs: Date.now() });
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 2);
  const served = async (config: string | undefined) => {
    const e = { ...env, TLOG_WITNESSES: config } as Env;
    const get = (path: string) => worker.fetch(new Request(`https://1f916.ai${path}`), e);
    const json = (await (await get("/api/checkpoint")).json()) as Record<string, unknown>;
    const note = await (await get("/api/checkpoint/note/identity_events")).text();
    return { json, lines: signatureLines(note) };
  };
  const before = await served(env.TLOG_WITNESSES);
  assert.equal((before.json.cosignatures as unknown[]).length, 2);
  assert.equal(before.lines.length, 2);

  // Removed from the configuration altogether: nothing configured, so the
  // response is the unconfigured one, with no new fields at all.
  const none = await served(undefined);
  for (const k of ["cosignatures", "cosigning_witnesses", "cosignature_format"]) assert.ok(!(k in none.json));
  assert.equal(none.lines.length, 1);

  // Replaced by another witness: configured, but this witness's lines are gone.
  const other = new FakeWitness(key.pub, "other.example/w");
  const replaced = await served(`https://other.example ${other.vkey()}`);
  assert.deepEqual(replaced.json.cosignatures, []);
  assert.equal(replaced.lines.length, 1);

  // The same name with a new key: the stored lines were by the old key.
  const rekeyed = new FakeWitness(key.pub, witness.name);
  assert.notEqual(rekeyed.vkey(), witness.vkey());
  const sameName = await served(`${WITNESS_URL} ${rekeyed.vkey()}`);
  assert.deepEqual(sameName.json.cosignatures, []);
  assert.equal(sameName.lines.length, 1);

  // The rows stay, as history, and come back if the witness does.
  assert.equal(count("SELECT COUNT(*) AS n FROM checkpoint_cosignatures"), 2);
  assert.equal((await served(env.TLOG_WITNESSES)).lines.length, 2);
});
