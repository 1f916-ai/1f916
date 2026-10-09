// The envelope tool (clients/envelope.mjs, served at /tools/envelope.mjs) and
// the registry's side of a locked record (src/mandates.ts).
//
// The tool locks a record's text to its owner's key on the caller's machine,
// in the standard age format. Two promises are tested here: that what it
// writes IS that format, so the owner is never locked into this tool, and that
// the registry claims about a locked file only what it can see.
//
// Pinned to the real age program without needing it installed: VECTOR below is
// a file written by age v1.3.2 itself, and `open` must read it. `seal` is
// pinned through `open`: whatever seal writes, the open that reads age's own
// file must read too. Checked by hand against the age binary on 2026-09-28, in
// both directions, at 0, 1, 15, 65535, 65536, 65537, 131072 and 200000 bytes.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   E1  change the X25519 stanza's HKDF label in open        -> "opens a file written by age itself"
//   E2  change the payload key's HKDF label in seal          -> "what seal writes, open reads, at every chunk boundary"
//   E3  put the last-chunk flag in the wrong byte            -> "the chunk nonce is the format's: an 11-byte counter, then the last flag"
//   E4  skip the header MAC check in open                    -> "a single changed byte anywhere is refused"
//   E5  edit the embedded copy and not the file              -> "the registry serves the file in the repository, byte for byte"
//   E6  make readEnvelope's check always true                -> "reading a record back checks the text against the sealed fingerprints"
//   E7  make isAgeFile always true                           -> "the registry says which format an envelope is in, from its first line only"
//   E8  claim the age sentence for an unrecognized envelope  -> "the page claims only what the registry can see"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { ENVELOPE_TOOL_SOURCE } from "../src/envelope-tool.ts";
import { ENVELOPE_TOOL_PATH, TOOLS_INDEX_PATH } from "../src/connect.ts";
import { createMandate, getMandate, mandatePage, envelopeSentence, isAgeFile, sha256Hex } from "../src/mandates.ts";
import type { Env, Citizen } from "../src/society.ts";
// @ts-expect-error a plain JavaScript module with no types: it is a tool, not part of the Worker
import * as tool from "../clients/envelope.mjs";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOOL_FILE = readFileSync(fileURLToPath(new URL("../clients/envelope.mjs", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const T0 = 1_790_000_000_000;

// A throwaway key made for this test and used for nothing else, and a file
// age v1.3.2 wrote to it: `age -r <public key> -o vector.age vector.txt`.
const VECTOR_KEY = "AGE-SECRET-KEY-1G8LZ4D5THMK5EJPL7Q4CZPWZD3R79TL8GS0QTHQ5NFMG0S32LCMS0FDZMU";
const VECTOR_PUBLIC = "age149e5uxds0fa7cdrtvcuvjnwjqf9fvy3stm37ctamkvl8zrf5jcqq2svg0c";
const VECTOR_FILE = Buffer.from(
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBPSi9qb3MyQ1U5Q0oxTCtuQjY4OFV5a21MR1JVNXB6dk9Cby9VOEM1NEdFCjNXNDhkWHI4U2c0anZHOWV2VWxteEpEOEd0Z2RjdU5pZUt3S2hYNDFpOTAKLS0tIFRINzlNS1dYWE9BTmUzWTZJeE1MUm9YWVZjV052T0RKVU4rR2hBbi9HeDAKKWOhdqT/r999YytlBxb64MvXxS3bqdzgxuLx6+/eAdvR9dRvrDTJR46UP3nJVB1KvIlrC94H6ZHvhyc=",
  "base64",
);
const VECTOR_TEXT = "1f916 envelope test vector\n";

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  const kv = new Map<string, string | Uint8Array>();
  const RECORDS = {
    put: async (k: string, v: string | Uint8Array) => void kv.set(k, v),
    get: async (k: string, type?: string) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return (v instanceof Uint8Array ? v : new TextEncoder().encode(v)).slice().buffer;
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    },
  };
  return { env: { ...env, RECORDS: RECORDS as unknown as KVNamespace } as Env, db, keeper: { id: 1, handle: "keeper" } as Citizen };
}

test("opens a file written by age itself", () => {
  assert.equal(tool.open(VECTOR_FILE, VECTOR_KEY).toString("utf8"), VECTOR_TEXT);
  // The key file form, comments and all, as age-keygen writes it.
  assert.equal(tool.open(VECTOR_FILE, `# created: 2026-09-28T00:00:00Z\n# public key: ${VECTOR_PUBLIC}\n${VECTOR_KEY}\n`).toString("utf8"), VECTOR_TEXT);
  // And the public key age printed for that secret is the one this tool derives.
  assert.equal(tool.bech32Encode("age", tool.parseRecipient(VECTOR_PUBLIC)), VECTOR_PUBLIC);
});

test("what seal writes, open reads, at every chunk boundary", () => {
  const k = tool.keygen(new Date(T0));
  assert.match(k.recipient, /^age1[a-z0-9]{58}$/);
  assert.match(k.identity, /^AGE-SECRET-KEY-1[A-Z0-9]{58}$/);
  assert.equal(k.file, `# created: ${new Date(T0).toISOString()}\n# public key: ${k.recipient}\n${k.identity}\n`);
  for (const n of [0, 1, 15, 65535, 65536, 65537, 131072, 140000]) {
    const plain = Buffer.alloc(n, 7);
    for (let i = 0; i < n; i += 997) plain[i] = i & 0xff;
    const sealed = tool.seal(plain, k.recipient);
    assert.ok(sealed.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n", `size ${n}: the file starts with the format's own line`);
    // The format's arithmetic: header, 16-byte nonce, then a 16-byte tag per chunk.
    const chunks = Math.max(1, Math.ceil(n / 65536));
    const headerLength = sealed.indexOf("\n", sealed.indexOf("\n--- ") + 1) + 1;
    assert.equal(sealed.length, headerLength + 16 + n + 16 * chunks, `size ${n}`);
    assert.ok(tool.open(sealed, k.identity).equals(plain), `size ${n} did not come back`);
  }
  // The same key that reads age's own file reads what seal writes to it.
  assert.equal(tool.open(tool.seal(Buffer.from("to the vector key"), VECTOR_PUBLIC), VECTOR_KEY).toString("utf8"), "to the vector key");
  // Two sealings of the same text share nothing: a fresh file key and nonce each time.
  assert.ok(!tool.seal(Buffer.from("same"), k.recipient).equals(tool.seal(Buffer.from("same"), k.recipient)));
});

test("the chunk nonce is the format's: an 11-byte counter, then the last flag", () => {
  assert.equal(tool.CHUNK_SIZE, 65536);
  const hex = (c: number, last: boolean) => Buffer.from(tool.streamNonce(c, last)).toString("hex");
  assert.equal(hex(0, false), "000000000000000000000000");
  assert.equal(hex(0, true), "000000000000000000000001");
  assert.equal(hex(1, false), "000000000000000000000100");
  assert.equal(hex(1, true), "000000000000000000000101");
  assert.equal(hex(258, true), "000000000000000000010201");
});

test("a file can be locked to more than one owner, and a stranger's key opens nothing", () => {
  const a = tool.keygen();
  const b = tool.keygen();
  const stranger = tool.keygen();
  const sealed = tool.seal(Buffer.from("for two"), [a.recipient, b.recipient]);
  assert.equal(tool.open(sealed, a.identity).toString("utf8"), "for two");
  assert.equal(tool.open(sealed, b.identity).toString("utf8"), "for two");
  assert.throws(() => tool.open(sealed, stranger.identity), /this key does not open it/);
  assert.throws(() => tool.seal(Buffer.from("x"), "age1notakey"), /bech32|not an age public key/);
  assert.throws(() => tool.seal(Buffer.from("x"), a.identity), /not an age public key/, "a secret key is never accepted where a public key belongs");
  assert.throws(() => tool.open(sealed, a.recipient), /not an age secret key/);
  assert.throws(() => tool.seal(Buffer.from("x"), tool.bech32Encode("age", Buffer.alloc(32))), /cannot be used/);
  assert.throws(() => tool.open(Buffer.from("not an age file\n"), a.identity), /not an age file/);
});

test("a single changed byte anywhere is refused", () => {
  const k = tool.keygen();
  const plain = Buffer.alloc(70000, 3);
  const sealed: Buffer = tool.seal(plain, k.recipient);
  const macLine = sealed.indexOf("\n--- ") + 1;
  const payload = sealed.indexOf("\n", macLine) + 1;
  const spots: [string, number][] = [
    ["the stanza's share", 35],
    ["the wrapped key", sealed.indexOf("\n", 30) + 5],
    ["the header MAC", macLine + 8],
    ["the payload nonce", payload + 2],
    ["the first chunk", payload + 16 + 100],
    ["the first chunk's tag", payload + 16 + 65536 + 3],
    ["the last chunk", sealed.length - 40],
    ["the last byte", sealed.length - 1],
  ];
  for (const [what, at] of spots) {
    const bent = Buffer.from(sealed);
    bent[at] ^= 0x01;
    assert.throws(() => tool.open(bent, k.identity), Error, `${what} was changed and the file still opened`);
  }
  // Cut short at a chunk boundary, and with the last chunk dropped: refused, never a shorter text.
  assert.throws(() => tool.open(sealed.subarray(0, payload + 16 + 65536 + 16), k.identity), /changed or cut short/);
  assert.throws(() => tool.open(sealed.subarray(0, sealed.length - 1), k.identity), /changed or cut short/);
  // A header MAC that is simply a different valid MAC.
  const other: Buffer = tool.seal(plain, k.recipient);
  const otherMacLine = other.indexOf("\n--- ") + 1;
  const swapped = Buffer.concat([sealed.subarray(0, macLine), other.subarray(otherMacLine, other.indexOf("\n", otherMacLine) + 1), sealed.subarray(payload)]);
  assert.throws(() => tool.open(swapped, k.identity), /header was changed/);
  assert.ok(tool.open(sealed, k.identity).equals(plain), "and the untouched file still opens");
});

test("reading a record back checks the text against the sealed fingerprints", () => {
  const k = tool.keygen();
  const made = tool.makeEnvelope({ instruction: "reorder gloves, cap $200", action: "ordered 40 boxes", outcome: "tx 0xabc" }, k.recipient);
  const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  assert.deepEqual(made.fingerprints, { instruction_hash: sha("reorder gloves, cap $200"), action_hash: sha("ordered 40 boxes"), outcome_hash: sha("tx 0xabc") });
  const record = { ...made.fingerprints };
  const good = tool.readEnvelope(made.envelope, k.identity, record);
  assert.deepEqual(good, { instruction: "reorder gloves, cap $200", action: "ordered 40 boxes", outcome: "tx 0xabc", checks: { instruction: true, action: true, outcome: true } });
  // The envelope of one record beside the fingerprints of another.
  const wrong = tool.readEnvelope(made.envelope, k.identity, { instruction_hash: sha("reorder gloves, cap $2000"), action_hash: record.action_hash, outcome_hash: record.outcome_hash });
  assert.deepEqual(wrong.checks, { instruction: false, action: true, outcome: true });
  // An outcome in the envelope that the record never sealed is not a match.
  assert.equal(tool.readEnvelope(made.envelope, k.identity, { instruction_hash: record.instruction_hash, action_hash: record.action_hash, outcome_hash: null }).checks.outcome, false);
  // An outcome added to the record later is found where the registry keeps it.
  assert.equal(tool.readEnvelope(made.envelope, k.identity, { instruction_hash: record.instruction_hash, action_hash: record.action_hash, outcome_hash: null, outcome_added: { outcome_hash: record.outcome_hash } }).checks.outcome, true);
  // No outcome in the envelope: nothing to check, and it says so.
  const bare = tool.makeEnvelope({ instruction: "a", action: "b" }, k.recipient);
  assert.equal(bare.fingerprints.outcome_hash, null);
  assert.equal(tool.readEnvelope(bare.envelope, k.identity, { instruction_hash: sha("a"), action_hash: sha("b"), outcome_hash: null }).checks.outcome, null);
  // An age file that is not an envelope is opened by open, and refused by readEnvelope.
  assert.throws(() => tool.readEnvelope(tool.seal(Buffer.from(JSON.stringify({ v: "something else" })), k.recipient), k.identity), /is not a 1f916\.envelope\.v1 envelope/);
  assert.throws(() => tool.makeEnvelope({ instruction: "", action: "b" }, k.recipient), /both as text/);
});

test("the registry serves the file in the repository, byte for byte", async () => {
  assert.equal(ENVELOPE_TOOL_SOURCE, TOOL_FILE, "run `node scripts/embed-envelope-tool.mjs`: src/envelope-tool.ts is not the file in clients/");
  // The router writes these two paths as literals; they must be the constants the index publishes.
  assert.equal(ENVELOPE_TOOL_PATH, "/tools/envelope.mjs");
  assert.equal(TOOLS_INDEX_PATH, "/tools/index.json");
  const { env } = fixture();
  const res = await worker.fetch(new Request(`${ORIGIN}${ENVELOPE_TOOL_PATH}`), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  const served = await res.text();
  assert.equal(served, TOOL_FILE);
  const idx = (await (await worker.fetch(new Request(`${ORIGIN}${TOOLS_INDEX_PATH}`), env)).json()) as { tools: { name: string; url: string; sha256: string; bytes: number }[] };
  assert.equal(idx.tools.length, 1);
  assert.equal(idx.tools[0].name, "envelope");
  assert.equal(idx.tools[0].url, `${ORIGIN}${ENVELOPE_TOOL_PATH}`);
  assert.equal(idx.tools[0].sha256, createHash("sha256").update(served, "utf8").digest("hex"), "the hash is of the bytes served");
  assert.equal(idx.tools[0].bytes, Buffer.byteLength(served));
  // The tool holds no secret and names no handle.
  assert.doesNotMatch(served, /AGE-SECRET-KEY-1[A-Z0-9]{20,}|1f916_sk_/);
});

test("the registry says which format an envelope is in, from its first line only", async () => {
  assert.equal(isAgeFile(new TextEncoder().encode("age-encryption.org/v1\n-> X25519 x\n")), true);
  assert.equal(isAgeFile(VECTOR_FILE), true);
  assert.equal(isAgeFile(new TextEncoder().encode("age-encryption.org/v1")), false, "without its newline it is not the line");
  assert.equal(isAgeFile(new TextEncoder().encode("age-encryption.org/v2\n")), false);
  assert.equal(isAgeFile(new TextEncoder().encode(" age-encryption.org/v1\n")), false);
  assert.equal(isAgeFile(new Uint8Array(0)), false);

  const { env, keeper } = fixture();
  const k = tool.keygen();
  const made = tool.makeEnvelope({ instruction: "told", action: "did" }, k.recipient);
  const locked = await createMandate(env, keeper, { instruction_hash: made.fingerprints.instruction_hash, action_hash: made.fingerprints.action_hash, envelope: made.envelope.toString("base64") }, T0);
  const other = await createMandate(env, keeper, { instruction_hash: "1".repeat(64), action_hash: "2".repeat(64), envelope: Buffer.from("just some bytes").toString("base64") }, T0 + 1);
  const none = await createMandate(env, keeper, { instruction_hash: "3".repeat(64), action_hash: "4".repeat(64) }, T0 + 2);
  assert.equal(((await getMandate(env, locked.id)) as { envelope_format: unknown }).envelope_format, "age-encryption.org/v1");
  assert.equal(((await getMandate(env, other.id)) as { envelope_format: unknown }).envelope_format, "not recognized");
  assert.equal(((await getMandate(env, none.id)) as { envelope_format: unknown }).envelope_format, null);

  // The whole loop through the router: store, fetch the bytes back, open, check.
  const bytes = Buffer.from(await (await worker.fetch(new Request(`${ORIGIN}/api/mandates/${locked.id}/envelope`), env)).arrayBuffer());
  assert.ok(bytes.equals(made.envelope), "the registry stores the bytes exactly as sent");
  const record = (await (await worker.fetch(new Request(`${ORIGIN}/api/mandates/${locked.id}`), env)).json()) as Record<string, unknown>;
  assert.equal(record.instruction, undefined, "a private record serves no text");
  const read = tool.readEnvelope(bytes, k.identity, record);
  assert.deepEqual(read, { instruction: "told", action: "did", outcome: null, checks: { instruction: true, action: true, outcome: null } });
  assert.equal(await sha256Hex("told"), record.instruction_hash);
});

test("the page claims only what the registry can see", async () => {
  // Two whole sentences, pinned as literals.
  assert.equal(
    envelopeSentence("age-encryption.org/v1", 215),
    "215 bytes whose first line says they are an age file (age-encryption.org/v1), the standard format the envelope tool at /tools/envelope.mjs writes. If they are, only the holder of the secret key they were locked to can read them, with that tool or with age itself. The registry reads the first line and nothing after it.",
  );
  assert.equal(envelopeSentence("not recognized", 15), "15 bytes stored here exactly as the owner sent them; the registry does not interpret them, so they stay private only if the owner encrypted them.");
  assert.equal(envelopeSentence(null, 15), envelopeSentence("not recognized", 15), "anything that is not the age line gets the sentence that promises nothing");

  const { env, keeper } = fixture();
  const k = tool.keygen();
  const made = tool.makeEnvelope({ instruction: "told", action: "did" }, k.recipient);
  const locked = await createMandate(env, keeper, { instruction_hash: made.fingerprints.instruction_hash, action_hash: made.fingerprints.action_hash, envelope: made.envelope.toString("base64") }, T0);
  // Bytes that wear the age line and are not locked at all: the page must not call them locked.
  const dressed = await createMandate(env, keeper, { instruction_hash: "1".repeat(64), action_hash: "2".repeat(64), envelope: Buffer.from("age-encryption.org/v1\nthis is plain text anyone can read").toString("base64") }, T0 + 1);
  const other = await createMandate(env, keeper, { instruction_hash: "5".repeat(64), action_hash: "6".repeat(64), envelope: Buffer.from("just some bytes").toString("base64") }, T0 + 2);
  const none = await createMandate(env, keeper, { instruction_hash: "3".repeat(64), action_hash: "4".repeat(64) }, T0 + 3);
  const lockedPage = await mandatePage(env, locked.id);
  assert.ok(lockedPage.includes(envelopeSentence("age-encryption.org/v1", made.envelope.length)));
  const dressedPage = await mandatePage(env, dressed.id);
  assert.match(dressedPage, /whose first line says they are an age file/);
  assert.match(dressedPage, /If they are, only the holder/);
  for (const page of [lockedPage, dressedPage]) assert.doesNotMatch(page, /cannot be read by anyone|is encrypted|are encrypted|is locked so/, "the registry cannot know that");
  const otherPage = await mandatePage(env, other.id);
  assert.ok(otherPage.includes(envelopeSentence("not recognized", 15)));
  assert.doesNotMatch(otherPage, /age file/);
  assert.doesNotMatch(await mandatePage(env, none.id), /Sealed envelope/);
});
