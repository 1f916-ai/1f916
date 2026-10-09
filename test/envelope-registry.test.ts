// The envelope tool's calls to the registry (recordLocked, readLocked,
// memoryPut, memoryGet in clients/envelope.mjs), run against the real router
// in-process. The tool takes its fetch as an argument, so nothing here opens a
// socket and every request it makes can be read.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   T1  memoryGet trusts the bytes without hashing them        -> "a swapped file is refused by the agent that reads it back"
//   T2  memoryPut never looks at the newest file               -> "a memory that has not changed is not stored again"
//   T3  --force is ignored                                     -> "a memory that has not changed is not stored again"
//   T4  recordLocked sends the text beside the envelope        -> "what leaves the machine is fingerprints and locked bytes, never the text or a key"
//   T5  memoryPut locks to the owner only, not to the agent    -> "the agent stores its memory and reads it back; the owner can open it too"
//   T6  the secret is put in the URL                           -> "what leaves the machine is fingerprints and locked bytes, never the text or a key"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { memoryKey } from "../src/memory.ts";
import type { Env } from "../src/society.ts";
// @ts-expect-error a plain JavaScript module with no types
import * as tool from "../clients/envelope.mjs";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

interface Sent { method: string; url: string; headers: Record<string, string>; body: string | null }

async function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const kv = new Map<string, Uint8Array | string>();
  const e = {
    ...env,
    RECORDS: {
      put: async (k: string, v: Uint8Array | string) => void kv.set(k, v),
      get: async (k: string, type?: string) => {
        const v = kv.get(k);
        if (v === undefined) return null;
        if (type === "arrayBuffer") return (v instanceof Uint8Array ? v : new TextEncoder().encode(v)).slice().buffer;
        return typeof v === "string" ? v : new TextDecoder().decode(v);
      },
      delete: async (k: string) => void kv.delete(k),
    } as unknown as KVNamespace,
  } as Env;
  const sent: Sent[] = [];
  const fetchInProcess = async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    sent.push({ method: init.method ?? "GET", url, headers, body: typeof init.body === "string" ? init.body : null });
    return worker.fetch(new Request(url, { ...init, headers: { ...headers, "CF-Connecting-IP": "203.0.113.20" } }), e);
  };
  const register = async (handle: string) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/register`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.21" }, body: JSON.stringify({ handle, model: "test-model" }) }), e);
    assert.equal(res.status, 201);
    return ((await res.json()) as { secret: string }).secret;
  };
  const secret = await register("tool-user");
  return { env: e, db, kv, sent, secret, register, io: { fetch: fetchInProcess, registry: ORIGIN, secret }, ioFor: (s: string) => ({ fetch: fetchInProcess, registry: ORIGIN, secret: s }) };
}

test("a record is made with its text locked beside it, and read back checked", async () => {
  const { io, db } = await fixture();
  const owner = tool.keygen();
  const made = await tool.recordLocked(io, { to: owner.recipient, instruction: "reorder gloves, cap $200", action: "ordered 40 boxes", outcome: "tx 0xabc", subject: "user:7f3a", label: "shop" });
  assert.ok(made.id > 0);
  assert.equal(made.public, false);
  assert.equal(made.subject, "user:7f3a");
  assert.deepEqual(made.stored, { instruction: false, action: false, outcome: false, envelope: true });
  const row = db.prepare("SELECT public, stored, label, subject FROM mandates WHERE id = ?").get(made.id) as Record<string, unknown>;
  assert.deepEqual({ ...row }, { public: 0, stored: 8 + 16, label: "shop", subject: "user:7f3a" });

  const got = await tool.readLocked(io, made.id, owner.identity);
  assert.equal(got.instruction, "reorder gloves, cap $200");
  assert.equal(got.action, "ordered 40 boxes");
  assert.equal(got.outcome, "tx 0xabc");
  assert.deepEqual(got.checks, { instruction: true, action: true, outcome: true });
  assert.equal(got.record.citizen, "tool-user");
  assert.equal(got.record.envelope_format, "age-encryption.org/v1");

  await assert.rejects(tool.readLocked(io, made.id, tool.keygen().identity), /this key does not open it/);
  await assert.rejects(tool.readLocked(io, 4242, owner.identity), /no record 4242/);
  await assert.rejects(tool.readLocked(io, "4; drop", owner.identity), /id is a number/);
  await assert.rejects(tool.recordLocked(io, { to: owner.recipient, instruction: "", action: "x" }), /--instruction/);
  await assert.rejects(tool.recordLocked({ ...io, secret: undefined }, { to: owner.recipient, instruction: "a", action: "b" }), /F916_SECRET/);
});

test("what leaves the machine is fingerprints and locked bytes, never the text or a key", async () => {
  const { io, sent, secret } = await fixture();
  const owner = tool.keygen();
  const agent = tool.keygen();
  const made = await tool.recordLocked(io, { to: owner.recipient, instruction: "the instruction in the clear", action: "the action in the clear", outcome: "the outcome in the clear" });
  await tool.readLocked(io, made.id, owner.identity);
  await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("the memory in the clear") });
  await tool.memoryGet(io, { label: "diary", keyText: agent.identity });
  assert.ok(sent.length >= 8, `the tool made ${sent.length} requests`);
  const bare = (s: string) => s.replace(/^AGE-SECRET-KEY-1/, "");
  for (const r of sent) {
    const wire = `${r.method} ${r.url}\n${Object.entries(r.headers).filter(([k]) => k !== "authorization").map(([k, v]) => `${k}: ${v}`).join("\n")}\n${r.body ?? ""}`;
    for (const clear of ["in the clear", secret, bare(owner.identity), bare(agent.identity), owner.identity.toLowerCase(), agent.identity.toLowerCase()]) {
      assert.ok(!wire.includes(clear) && !wire.toLowerCase().includes(clear.toLowerCase()), `${r.method} ${r.url} carried "${clear.slice(0, 24)}..." outside the Authorization header`);
    }
    if (r.headers.authorization !== undefined) assert.equal(r.headers.authorization, `Bearer ${secret}`);
  }
  // The record is always private, and the reads that need no credential send none.
  const recordBody = JSON.parse(sent.find((r) => r.method === "POST" && r.url.endsWith("/api/mandates"))!.body!) as Record<string, unknown>;
  assert.equal(recordBody.public, false);
  assert.deepEqual(Object.keys(recordBody).sort(), ["action_hash", "envelope", "instruction_hash", "outcome_hash", "public"]);
  for (const r of sent.filter((x) => x.method === "GET" && /\/api\/mandates\/\d+/.test(x.url))) assert.equal(r.headers.authorization, undefined, "reading a record needs no secret, so none is sent");
  for (const r of sent.filter((x) => /\/api\/memory\?/.test(x.url))) assert.equal(r.headers.authorization, undefined, "listing needs no secret, so none is sent");
});

test("the agent stores its memory and reads it back; the owner can open it too", async () => {
  const { io, kv } = await fixture();
  const agent = tool.keygen();
  const owner = tool.keygen();
  const stored = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("what I learned today"), to: owner.recipient });
  assert.equal(stored.stored, true);
  assert.equal(stored.label, "diary");
  const got = await tool.memoryGet(io, { label: "diary", keyText: agent.identity });
  assert.equal(got.plain.toString("utf8"), "what I learned today");
  assert.equal(got.entry.id, stored.id);
  // The bytes held are locked to both, and to nobody else.
  const held = Buffer.from(kv.get(memoryKey(stored.id)) as Uint8Array);
  assert.equal(tool.open(held, owner.identity).toString("utf8"), "what I learned today");
  assert.equal(tool.open(held, agent.identity).toString("utf8"), "what I learned today");
  assert.throws(() => tool.open(held, tool.keygen().identity), /this key does not open it/);
  // Without --to, the agent alone.
  const alone = await tool.memoryPut(io, { label: "notes", keyText: agent.identity, plain: Buffer.from("only mine") });
  assert.throws(() => tool.open(Buffer.from(kv.get(memoryKey(alone.id)) as Uint8Array), owner.identity), /this key does not open it/);
  await assert.rejects(tool.memoryGet(io, { label: "nothing-here", keyText: agent.identity }), /nothing is held under 'nothing-here'/);
  await assert.rejects(tool.memoryPut(io, { label: "diary", keyText: undefined, plain: Buffer.from("x") }), /needs the agent's own key/);
});

test("a memory that has not changed is not stored again", async () => {
  const { io, db } = await fixture();
  const agent = tool.keygen();
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM memory_blobs").get() as { n: number }).n;
  const first = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("day one") });
  assert.equal(count(), 1);
  const again = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("day one") });
  assert.deepEqual([again.stored, again.unchanged, again.id], [false, true, first.id]);
  assert.equal(count(), 1, "nothing was stored");
  const changed = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("day two") });
  assert.equal(changed.stored, true);
  assert.notEqual(changed.id, first.id);
  assert.equal(count(), 2);
  // --force stores it though nothing changed: a fresh lock, fresh bytes, a new seal.
  const forced = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("day two"), force: true });
  assert.equal(forced.stored, true);
  assert.equal(count(), 3);
  // Another label is another memory.
  assert.equal((await tool.memoryPut(io, { label: "notes", keyText: agent.identity, plain: Buffer.from("day two") })).stored, true);
  // A newest file this key cannot open is not "unchanged": the memory is stored.
  const otherKey = tool.keygen();
  assert.equal((await tool.memoryPut(io, { label: "diary", keyText: otherKey.identity, plain: Buffer.from("day two") })).stored, true);
});

test("a swapped file is refused by the agent that reads it back", async () => {
  const { io, kv } = await fixture();
  const agent = tool.keygen();
  const stored = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("the real memory") });
  // The registry, or whoever holds its storage, puts another file in its place:
  // a well-formed one, locked to the agent's own key, that opens without complaint.
  kv.set(memoryKey(stored.id), new Uint8Array(tool.seal(Buffer.from("a memory the agent never wrote"), agent.recipient)));
  await assert.rejects(tool.memoryGet(io, { label: "diary", keyText: agent.identity }), /is NOT the file that was sealed/);
  // And memoryPut does not mistake the swapped file for the agent's own.
  const again = await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("a memory the agent never wrote") });
  assert.equal(again.stored, true, "the swapped file is not trusted as 'unchanged'");
});

test("another citizen's secret lists the memory and cannot download it", async () => {
  const { io, ioFor, register } = await fixture();
  const agent = tool.keygen();
  await tool.memoryPut(io, { label: "diary", keyText: agent.identity, plain: Buffer.from("mine") });
  const stranger = ioFor(await register("tool-stranger"));
  await assert.rejects(tool.memoryGet(stranger, { label: "diary", keyText: agent.identity, citizen: "tool-user" }), /could not download memory \d+ \(403\)/);
  // Its own label is empty.
  await assert.rejects(tool.memoryGet(stranger, { label: "diary", keyText: agent.identity }), /nothing is held under 'diary'/);
});
