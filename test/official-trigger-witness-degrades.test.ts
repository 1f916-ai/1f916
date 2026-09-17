// THE TRIGGER WITNESS MUST NEVER TAKE DOWN THE RECORD IT SITS BESIDE.
//
// Before PR #234, GET /api/official was the one endpoint in this registry with
// no database dependency at all: officialFacts is pure and synchronous. #234
// merged in servedTriggerWitness, which is the FIRST sqlite_master read
// anywhere in serving code and has only ever run against node:sqlite, never
// against real D1. Unguarded, any D1 error there would 500 the whole
// anti-phishing record — the document the payload gate tells citizens to check
// an address against — because a diagnostic beside it could not answer.
// A witness may report UNKNOWN. It may not silence the building it is in.
//
// Found by the pre-deploy auditor on the #234 merge, before it shipped.
//
// KILLING MUTATIONS this file catches:
//   1. delete the try/catch in servedTriggerWitness — test 1 goes red with a
//      thrown error instead of a 200, and test 2 goes red (500, not 200).
//   2. return `triggers_missing: []` instead of null on the failure path —
//      test 3 goes red. An empty list is a claim that nothing is missing;
//      a failed read has no standing to make it.
//   3. rename triggers_note back to a bare `note` — test 4 goes red. The
//      witness is spread LAST into a 26-key identity document, so a bare
//      `note` silently clobbers the day officialFacts grows one.
//   4. revert the MCP `official` tool to `officialFacts(env)` alone — test 5
//      goes red. src/surface.ts advertises /mcp as mirroring the HTTP API.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { servedTriggerWitness, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// A D1 that answers every other query normally and throws on exactly the
// sqlite_master read. Narrow on purpose: a stub that throws on everything
// would prove the endpoint dies for unrelated reasons, which is not the claim.
function envWithBrokenTriggerRead(): Env {
  const { env } = sqliteTestEnv(schema);
  const real = env.DB;
  const broken = {
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return {
          bind: () => broken.prepare(sql),
          first: async () => {
            throw new Error("D1_ERROR: no such table: sqlite_master");
          },
          all: async () => {
            throw new Error("D1_ERROR: no such table: sqlite_master");
          },
        };
      }
      return real.prepare(sql);
    },
  };
  return { ...(env as object), DB: broken } as unknown as Env;
}

test("a failed sqlite_master read degrades the witness instead of throwing", async () => {
  const body = await servedTriggerWitness(envWithBrokenTriggerRead());
  assert.equal(body.triggers, null, "triggers is null, not an empty list");
  assert.ok(Array.isArray(body.triggers_expected) && body.triggers_expected.length > 0,
    "what this code DECLARES is unaffected by a read failure and is still served");
  assert.match(String(body.triggers_note), /could not read sqlite_master/);
  assert.match(String(body.triggers_note), /D1_ERROR/, "the reason is named, not swallowed");
});

test("GET /api/official is still 200 and still carries the anti-phishing record when the witness cannot read", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/official`), envWithBrokenTriggerRead());
  assert.equal(res.status, 200, "a broken diagnostic must not 500 the record of record");
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(body.official_token, "the token facts survive");
  assert.ok(body.treasury, "the treasury facts survive");
  assert.equal(body.triggers, null);
});

test("a failed read reports UNKNOWN, never 'nothing is missing'", async () => {
  const body = await servedTriggerWitness(envWithBrokenTriggerRead());
  assert.equal(body.triggers_missing, null,
    "an empty triggers_missing is a positive claim that every declared trigger is installed; a read that failed cannot make it");
  assert.notDeepEqual(body.triggers_missing, [], "specifically: not the empty list");
});

test("the witness contributes no bare `note` key that could clobber the document it is spread into", async () => {
  const { env } = sqliteTestEnv(schema);
  const ok = await servedTriggerWitness(env as Env);
  assert.ok(!("note" in ok), "healthy path must not add a bare `note`");
  assert.ok("triggers_note" in ok);
  const broken = await servedTriggerWitness(envWithBrokenTriggerRead());
  assert.ok(!("note" in broken), "failure path must not add a bare `note` either");
});

test("the MCP `official` tool mirrors the HTTP endpoint, witness included", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "official", arguments: {} },
      }),
    }),
    env as Env,
  );
  assert.equal(res.status, 200);
  const rpc = (await res.json()) as { result?: { content?: { text?: string }[] }; error?: unknown };
  assert.equal(rpc.error, undefined);
  const text = rpc.result?.content?.[0]?.text ?? "";
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.ok(body.official_token, "still the official facts");
  assert.ok(Array.isArray(body.triggers_expected),
    "and the trigger witness, because surface.ts calls /mcp a mirror of the HTTP API");
  assert.ok("triggers_missing" in body);
});

test("the served reason is bounded, because a D1 message is other people's text on a public field", async () => {
  // The witness serves the read failure's reason so a reader knows WHY the
  // answer is UNKNOWN. That reason originates outside this code. Everywhere
  // else in this repo a caught error is logged and a FIXED string is served;
  // serving it at all is the exception, so it is capped rather than passed
  // through whole. Advisory from the pre-deploy auditor on this change.
  //
  // KILLING MUTATION: drop the .slice(0, 200) in servedTriggerWitness. The
  // 5,000-character message rides into triggers_note intact and this goes red.
  const { env } = sqliteTestEnv(schema);
  const real = env.DB;
  const huge = "E".repeat(5000);
  const broken = {
    prepare(sql: string) {
      if (sql.includes("sqlite_master")) {
        return {
          bind: () => broken.prepare(sql),
          first: async () => {
            throw new Error(huge);
          },
          all: async () => {
            throw new Error(huge);
          },
        };
      }
      return real.prepare(sql);
    },
  };
  const body = await servedTriggerWitness({ ...(env as object), DB: broken } as unknown as Env);
  const note = String(body.triggers_note);
  assert.ok(note.length < 600, `triggers_note grew to ${note.length} chars on a 5,000-char D1 message`);
  assert.ok(!note.includes(huge), "the whole message must not ride through");
  assert.match(note, /E{200}/, "the first 200 characters ARE served — bounded, not swallowed");
  assert.doesNotMatch(note, /E{201}/, "and not one character more");
});
