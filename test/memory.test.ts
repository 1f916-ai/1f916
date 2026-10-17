// Stored memory (src/memory.ts): locked files an agent keeps at the registry.
//
// Three promises. Plain text is refused at the door. Only the citizen who stored
// a file can download it. And the seal in the chain is the sha-256 of exactly
// the bytes held, so a swapped file is caught by the agent that reads it back.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   K1  skip the age-shape check                          -> "nothing is stored in the clear"
//   K2  skip the owner check                              -> "only the citizen who stored a file can download or delete it"
//   K3  serve the file without reading a credential        -> "over HTTP: the file needs its owner's secret, the list needs nothing"
//   K4  skip both size checks (the one on the text, and     -> "a file over the cap is refused before it is stored"
//       the one on the decoded bytes; either alone holds)
//   K5  never drop old versions                            -> "the newest five of a label are kept, and the older ones lose their bytes"
//   K6  drop `AND label = ?` from the retention query      -> "the newest five of a label are kept, and the older ones lose their bytes"
//   K7  skip the label cap                                 -> "a citizen keeps at most ten labels"
//   K8  leave the bytes in storage on delete               -> "delete removes the bytes and keeps the seal"
//   K9  seal something other than the bytes' sha-256       -> "the seal is the sha-256 of the bytes held"
//   K10 serve a deleted file                               -> "delete removes the bytes and keeps the seal"
//   K11 let a hand-made seal wear a stored label            -> "a seal made by hand cannot wear a stored label"
//       (the defect the deploy audit found: it sealed a file's hash by hand under stored.diary and could then never store the file)
//   K12 answer "unchanged" without putting the bytes back   -> "the newest file's bytes, deleted and sent again, go back under the same seal"
//   K13 match ANY earlier file of the label, not the newest -> "the newest file's bytes, deleted and sent again, go back under the same seal"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { storeMemory, listMemory, memoryFile, deleteMemory, whyNotAgeFile, memoryKey, MEMORY_MAX_BYTES, MEMORY_KEEP, MEMORY_LABELS, MEMORY_SEAL_PREFIX } from "../src/memory.ts";
import { SocietyError, sealMemory, type Env, type Citizen } from "../src/society.ts";
// @ts-expect-error a plain JavaScript module with no types
import * as tool from "../clients/envelope.mjs";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const T0 = 1_790_000_000_000;
// A file age v1.3.2 itself wrote (the vector in test/envelope-tool.test.ts).
const AGE_WROTE_THIS = Buffer.from(
  "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBPSi9qb3MyQ1U5Q0oxTCtuQjY4OFV5a21MR1JVNXB6dk9Cby9VOEM1NEdFCjNXNDhkWHI4U2c0anZHOWV2VWxteEpEOEd0Z2RjdU5pZUt3S2hYNDFpOTAKLS0tIFRINzlNS1dYWE9BTmUzWTZJeE1MUm9YWVZjV052T0RKVU4rR2hBbi9HeDAKKWOhdqT/r999YytlBxb64MvXxS3bqdzgxuLx6+/eAdvR9dRvrDTJR46UP3nJVB1KvIlrC94H6ZHvhyc=",
  "base64",
);

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'sleeper', 'test-model', 'h1', 0, 0), (2, 'other', 'test-model', 'h2', 0, 0)`);
  const kv = new Map<string, Uint8Array | string>();
  const RECORDS = {
    put: async (k: string, v: Uint8Array | string) => void kv.set(k, v),
    get: async (k: string, type?: string) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return (v instanceof Uint8Array ? v : new TextEncoder().encode(v)).slice().buffer;
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    },
    delete: async (k: string) => void kv.delete(k),
  };
  return { env: { ...env, RECORDS: RECORDS as unknown as KVNamespace } as Env, db, kv, sleeper: { id: 1, handle: "sleeper" } as Citizen, other: { id: 2, handle: "other" } as Citizen };
}

const key = tool.keygen();
const lock = (text: string | Buffer): Buffer => tool.seal(Buffer.from(text), key.recipient);
const b64 = (b: Buffer) => b.toString("base64");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function refused(p: Promise<unknown>, status: number, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SocietyError, String(e));
    assert.equal(e.status, status, e.message);
    assert.match(e.message, re);
    return true;
  });
}

test("the door check knows the shape of a locked file", () => {
  assert.equal(whyNotAgeFile(AGE_WROTE_THIS), null, "a file age itself wrote");
  assert.equal(whyNotAgeFile(lock("what the tool writes")), null);
  assert.equal(whyNotAgeFile(tool.seal(Buffer.from("to two"), [key.recipient, tool.keygen().recipient])), null);
  assert.equal(whyNotAgeFile(lock(Buffer.alloc(0))), null, "an empty memory is still a locked file");
  const enc = (t: string) => new TextEncoder().encode(t);
  assert.match(whyNotAgeFile(enc("my diary: the password is hunter2\n")) ?? "", /does not start with/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v2\n-> X25519 x\ny\n--- z\n")) ?? "", /does not start with/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\n")) ?? "", /does not end/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\nplain text dressed as a header\nand more\n")) ?? "", /neither a recipient nor the closing line/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\n--- " + "A".repeat(43) + "\n" + "x".repeat(40))) ?? "", /locked to nobody/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\n-> X25519 abc\nAAAA\n--- tooshort\n" + "x".repeat(40))) ?? "", /not a 32-byte MAC/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\n-> X25519 abc\nAAAA\n--- " + "A".repeat(43) + "\nshort")) ?? "", /no payload/);
  assert.match(whyNotAgeFile(enc("age-encryption.org/v1\n-> X25519 abc\nnot base64 !!\n--- " + "A".repeat(43) + "\n" + "x".repeat(40))) ?? "", /not base64/);
  assert.match(whyNotAgeFile(new Uint8Array(0)) ?? "", /does not start with/);
});

test("nothing is stored in the clear", async () => {
  const { env, db, kv, sleeper } = fixture();
  for (const plain of ["my diary: the password is hunter2", JSON.stringify({ notes: "remember the key" }), "age-encryption.org/v1\nthis is plain text anyone can read\n"]) {
    await refused(storeMemory(env, sleeper, { label: "diary", file: b64(Buffer.from(plain)) }, T0), 400, /does not have the shape of a locked age file/);
  }
  await refused(storeMemory(env, sleeper, { label: "diary" }, T0), 400, /file is required/);
  await refused(storeMemory(env, sleeper, { label: "diary", file: "not base64 !!" }, T0), 400, /must be base64/);
  await refused(storeMemory(env, sleeper, { file: b64(lock("x")) }, T0), 400, /label is required/);
  await refused(storeMemory(env, sleeper, { label: "Has Space", file: b64(lock("x")) }, T0), 400, /label is required/);
  assert.equal(kv.size, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_blobs").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, 0, "and nothing was sealed");
});

test("the seal is the sha-256 of the bytes held", async () => {
  const { env, db, kv, sleeper } = fixture();
  const file = lock("what I learned today");
  const r = await storeMemory(env, sleeper, { label: "diary", file: b64(file) }, T0);
  assert.equal(r.stored, true);
  assert.equal(r.sha256, sha(file));
  assert.equal(r.bytes, file.length);
  const held = kv.get(memoryKey(r.id)) as Uint8Array;
  assert.ok(Buffer.from(held).equals(file), "the bytes are held exactly as sent");
  const seal = db.prepare("SELECT label, hash, citizen_id FROM seals WHERE id = ?").get(r.seal.id) as { label: string; hash: string; citizen_id: number };
  assert.deepEqual({ ...seal }, { label: MEMORY_SEAL_PREFIX + "diary", hash: sha(file), citizen_id: 1 });
  assert.equal(r.seal.label, "stored.diary");
  const ev = db.prepare("SELECT kind FROM identity_events WHERE hash = ?").get(r.seal.chained) as { kind: string };
  assert.equal(ev.kind, "memory.seal");
  // What comes back is what went in, and the owner's key opens it.
  const got = await memoryFile(env, sleeper, r.id);
  assert.equal(got.sha256, sha(got.bytes));
  assert.equal(tool.open(Buffer.from(got.bytes), key.identity).toString("utf8"), "what I learned today");
  // A swapped file is caught by the hash the agent computes itself.
  kv.set(memoryKey(r.id), new Uint8Array(lock("something the registry made up")));
  const swapped = await memoryFile(env, sleeper, r.id);
  assert.notEqual(sha(swapped.bytes), swapped.sha256, "the seal still says what the bytes were");
});

test("only the citizen who stored a file can download or delete it", async () => {
  const { env, kv, sleeper, other } = fixture();
  const r = await storeMemory(env, sleeper, { label: "diary", file: b64(lock("mine")) }, T0);
  await refused(memoryFile(env, other, r.id), 403, /another citizen's/);
  await refused(deleteMemory(env, other, r.id, T0 + 1), 403, /another citizen's/);
  assert.ok(kv.has(memoryKey(r.id)), "and the stranger's delete deleted nothing");
  await refused(memoryFile(env, sleeper, 4242), 404, /no stored memory 4242/);
  await refused(memoryFile(env, sleeper, NaN), 400, /id is required/);
  assert.equal((await memoryFile(env, sleeper, r.id)).label, "diary");
});

test("a file over the cap is refused before it is stored", async () => {
  const { env, kv, sleeper } = fixture();
  assert.equal(MEMORY_MAX_BYTES, 262_144);
  const big = lock(Buffer.alloc(MEMORY_MAX_BYTES, 1));
  assert.ok(big.length > MEMORY_MAX_BYTES);
  await refused(storeMemory(env, sleeper, { label: "diary", file: b64(big) }, T0), 413, /larger than 262144 bytes/);
  // The largest that fits: the cap is on the locked file, overhead and all.
  let n = MEMORY_MAX_BYTES - 400;
  let fits = lock(Buffer.alloc(n, 1));
  while (fits.length > MEMORY_MAX_BYTES) fits = lock(Buffer.alloc(--n, 1));
  while (fits.length < MEMORY_MAX_BYTES) fits = lock(Buffer.alloc(++n, 1));
  assert.equal(fits.length, MEMORY_MAX_BYTES);
  const ok = await storeMemory(env, sleeper, { label: "diary", file: b64(fits) }, T0);
  assert.equal(ok.bytes, MEMORY_MAX_BYTES);
  assert.equal(kv.size, 1);
});

test("the newest five of a label are kept, and the older ones lose their bytes", async () => {
  const { env, db, kv, sleeper } = fixture();
  assert.equal(MEMORY_KEEP, 5);
  const notes = await storeMemory(env, sleeper, { label: "notes", file: b64(lock("a different label")) }, T0);
  const ids: number[] = [];
  let lastDropped: number[] = [];
  for (let i = 0; i < 7; i++) {
    const r = await storeMemory(env, sleeper, { label: "diary", file: b64(lock("day " + i)) }, T0 + 1 + i);
    ids.push(r.id);
    lastDropped = r.dropped;
  }
  assert.deepEqual(lastDropped, [ids[1]], "the seventh drops the second; the sixth had dropped the first");
  const held = ids.filter((id) => kv.has(memoryKey(id)));
  assert.deepEqual(held, ids.slice(2), "the newest five");
  assert.ok(kv.has(memoryKey(notes.id)), "another label's file is untouched");
  const rows = db.prepare("SELECT id, deleted_at, deleted_why FROM memory_blobs WHERE label = 'diary' ORDER BY id").all() as { id: number; deleted_at: number | null; deleted_why: string | null }[];
  assert.deepEqual(rows.map((r) => r.deleted_why), ["superseded", "superseded", null, null, null, null, null]);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE label = 'stored.diary'").get() as { n: number }).n, 7, "every seal stays");
  await refused(memoryFile(env, sleeper, ids[0]), 410, /no longer held here \(superseded\)/);
  const list = await listMemory(env, "sleeper", "diary", undefined);
  assert.deepEqual(list.memory.map((m) => m.id), [...ids].reverse(), "newest first, the dropped ones still listed");
  assert.deepEqual(list.memory.map((m) => m.held), [true, true, true, true, true, false, false]);
  assert.deepEqual(list.memory.map((m) => m.download === null), [false, false, false, false, false, true, true]);
  assert.equal((await listMemory(env, "sleeper", null, undefined)).memory.length, 8);
  assert.deepEqual((await listMemory(env, "sleeper", null, ids[1])).memory.map((m) => m.id), [ids[0], notes.id], "before_id pages backwards");
});

test("the same file again is a check, not a second copy", async () => {
  const { env, db, kv, sleeper } = fixture();
  const file = b64(lock("unchanged since yesterday"));
  const first = await storeMemory(env, sleeper, { label: "diary", file }, T0);
  const again = await storeMemory(env, sleeper, { label: "diary", file }, T0 + 1);
  assert.equal(again.stored, false);
  assert.equal(again.unchanged, true);
  assert.equal(again.restored, false);
  assert.equal(again.id, first.id);
  assert.equal(kv.size, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_blobs").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get() as { n: number }).n, 1, "recorded as a check that it still matched");
});

test("a citizen keeps at most ten labels", async () => {
  const { env, sleeper, other } = fixture();
  assert.equal(MEMORY_LABELS, 10);
  for (let i = 0; i < MEMORY_LABELS; i++) await storeMemory(env, sleeper, { label: "label-" + i, file: b64(lock("m" + i)) }, T0 + i);
  await refused(storeMemory(env, sleeper, { label: "one-too-many", file: b64(lock("x")) }, T0 + 50), 409, /you hold 10 labels/);
  // A label already held is still written to.
  assert.equal((await storeMemory(env, sleeper, { label: "label-3", file: b64(lock("again")) }, T0 + 51)).stored, true);
  // Deleting a label's only file frees it.
  const mine = (await listMemory(env, "sleeper", "label-0", undefined)).memory[0];
  await deleteMemory(env, sleeper, mine.id, T0 + 52);
  assert.equal((await storeMemory(env, sleeper, { label: "one-too-many", file: b64(lock("x")) }, T0 + 53)).stored, true);
  // And the count is each citizen's own.
  assert.equal((await storeMemory(env, other, { label: "theirs", file: b64(lock("y")) }, T0 + 54)).stored, true);
});

test("delete removes the bytes and keeps the seal", async () => {
  const { env, db, kv, sleeper } = fixture();
  const r = await storeMemory(env, sleeper, { label: "diary", file: b64(lock("forget this")) }, T0);
  const d = await deleteMemory(env, sleeper, r.id, T0 + 5);
  assert.equal(d.deleted, true);
  assert.equal(d.held, false);
  assert.equal(d.deleted_why, "deleted by its owner");
  assert.equal(kv.has(memoryKey(r.id)), false, "the bytes are gone from storage");
  await refused(memoryFile(env, sleeper, r.id), 410, /no longer held here \(deleted by its owner\)/);
  assert.equal((db.prepare("SELECT hash FROM seals WHERE id = ?").get(r.seal.id) as { hash: string }).hash, r.sha256, "the seal is still there");
  const again = await deleteMemory(env, sleeper, r.id, T0 + 6);
  assert.equal(again.deleted, false);
  assert.equal((await listMemory(env, "sleeper", "diary", undefined)).memory[0].held, false);
});

test("over HTTP: the file needs its owner's secret, the list needs nothing", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const kv = new Map<string, Uint8Array | string>();
  const e = {
    ...env,
    RECORDS: {
      put: async (k: string, v: Uint8Array | string) => void kv.set(k, v),
      get: async (k: string, type?: string) => {
        const v = kv.get(k);
        if (v === undefined) return null;
        return type === "arrayBuffer" ? (v as Uint8Array).slice().buffer : v;
      },
      delete: async (k: string) => void kv.delete(k),
    } as unknown as KVNamespace,
  } as Env;
  const call = (method: string, path: string, secret?: string, body?: unknown) =>
    worker.fetch(
      new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.11", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      e,
    );
  const register = async (handle: string) => ((await (await call("POST", "/api/register", undefined, { handle, model: "test-model" })).json()) as { secret: string }).secret;
  const mine = await register("http-sleeper");
  const theirs = await register("http-other");
  const file = lock("over the wire");

  assert.equal((await call("POST", "/api/memory", undefined, { label: "diary", file: b64(file) })).status, 401);
  const stored = await call("POST", "/api/memory", mine, { label: "diary", file: b64(file) });
  assert.equal(stored.status, 201, await stored.clone().text());
  const { id, sha256, download } = (await stored.json()) as { id: number; sha256: string; download: string };
  assert.equal(download, `/api/memory/${id}/file`);

  const list = await call("GET", "/api/memory?citizen=http-sleeper&label=diary");
  assert.equal(list.status, 200);
  const listed = (await list.json()) as { memory: Record<string, unknown>[] };
  assert.equal(listed.memory.length, 1);
  assert.equal(listed.memory[0].sha256, sha256);
  assert.ok(!JSON.stringify(listed).includes(b64(file).slice(0, 40)), "the list carries no bytes");
  assert.equal((await call("GET", "/api/memory")).status, 400, "whose memory must be said");
  assert.equal((await call("GET", "/api/memory?citizen=http-sleeper&lable=diary")).status, 400, "an unknown parameter is refused");

  assert.equal((await call("GET", download)).status, 401, "no credential, no file");
  assert.equal((await call("GET", download, theirs)).status, 403, "another citizen's credential, no file");
  const got = await call("GET", download, mine);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/octet-stream");
  assert.match(got.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(got.headers.get("x-1f916-sha256"), sha256);
  const bytes = Buffer.from(await got.arrayBuffer());
  assert.ok(bytes.equals(file));
  assert.equal(tool.open(bytes, key.identity).toString("utf8"), "over the wire");

  assert.equal((await call("POST", `/api/memory/${id}/delete`, theirs)).status, 403);
  assert.equal((await call("POST", `/api/memory/${id}/delete`, mine)).status, 200);
  assert.equal((await call("GET", download, mine)).status, 410);
});

test("a seal made by hand cannot wear a stored label", async () => {
  const { env, db, kv, sleeper } = fixture();
  const file = lock("about to be stored");
  // The order the audit used: seal the file's own fingerprint by hand first.
  await refused(sealMemory(env, sleeper, { hash: sha(file), label: "stored.diary" }), 400, /labels beginning 'stored\.' are reserved/);
  await refused(sealMemory(env, sleeper, { hash: sha(file), label: "  stored.diary  " }), 400, /reserved/);
  await refused(sealMemory(env, sleeper, { hash: "a".repeat(64), label: "stored.anything-at-all" }), 400, /reserved/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, 0, "nothing was sealed");
  // So the file stores, and the only seal under that label is the file's.
  const r = await storeMemory(env, sleeper, { label: "diary", file: b64(file) }, T0);
  assert.equal(r.stored, true);
  assert.ok(kv.has(memoryKey(r.id)));
  const seals = db.prepare("SELECT id, hash FROM seals WHERE label = 'stored.diary'").all() as { id: number; hash: string }[];
  assert.deepEqual(seals.map((x) => ({ ...x })), [{ id: r.seal.id, hash: sha(file) }]);
  // A label that merely resembles the prefix is an ordinary label.
  assert.equal((await sealMemory(env, sleeper, { hash: "b".repeat(64), label: "storedx" })).sealed, true);
  assert.equal((await sealMemory(env, sleeper, { hash: "c".repeat(64), label: "restored.diary" })).sealed, true);
});

test("the newest file's bytes, deleted and sent again, go back under the same seal", async () => {
  const { env, db, kv, sleeper } = fixture();
  const a = lock("version a");
  const first = await storeMemory(env, sleeper, { label: "diary", file: b64(a) }, T0);
  await deleteMemory(env, sleeper, first.id, T0 + 1);
  assert.equal(kv.has(memoryKey(first.id)), false);
  const back = await storeMemory(env, sleeper, { label: "diary", file: b64(a) }, T0 + 2);
  assert.equal(back.id, first.id, "the same row");
  assert.equal(back.seal.id, first.seal.id, "and the same seal");
  assert.deepEqual([back.stored, back.unchanged, back.restored, back.held], [true, true, true, true]);
  assert.ok(Buffer.from(kv.get(memoryKey(first.id)) as Uint8Array).equals(a), "the bytes are held again");
  assert.ok(Buffer.from((await memoryFile(env, sleeper, first.id)).bytes).equals(a));
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM memory_blobs").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE label = 'stored.diary'").get() as { n: number }).n, 1);

  // Once a different file is the newest, the earlier bytes sent again are a new file.
  const second = await storeMemory(env, sleeper, { label: "diary", file: b64(lock("version b")) }, T0 + 3);
  const third = await storeMemory(env, sleeper, { label: "diary", file: b64(a) }, T0 + 4);
  assert.notEqual(third.id, first.id);
  assert.ok(third.id > second.id);
  assert.deepEqual([third.stored, third.unchanged, third.restored], [true, false, false]);
  assert.notEqual(third.seal.id, first.seal.id, "with a seal of its own");
  assert.deepEqual((await listMemory(env, "sleeper", "diary", undefined)).memory.map((m) => [m.id, m.held]), [[third.id, true], [second.id, true], [first.id, true]]);
});
