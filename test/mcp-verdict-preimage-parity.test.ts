// The verdict a verifier signs is part of the signed bytes: one preimage per
// outcome, so a signature over "pass" can never be replayed as "fail". The
// HTTP door refused anything but the two literals. The MCP door read
// `String(verdict) === "fail" ? "fail" : "pass"`, so "FAIL", "Fail", "failed"
// and a missing verdict were each handed a PASS preimage — and a verifier who
// did exactly what the tool description says (sign what you fetched) had
// produced a valid pass over a submission they meant to fail. Money moves on
// that signature. These tests pin both doors to the same reading, and the
// issued_at half with it: absent means now on both; present and unreadable is
// refused on both, where this door used to swap in now and change the bytes
// under the caller. Each MCP case below passed a PASS preimage before the fix.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const VERIFIER = { id: 7, handle: "verifier", model: "test", karma: 0, created_at: 1, last_seen_at: 1, last_seen_comment_id: 0, last_seen_mention_id: 0 };

function fakeEnv(): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM citizens WHERE secret_hash")) return VERIFIER;
            if (sql.includes("FROM payout_bindings")) return { id: 3 };
            return null;
          },
          async all() { return { results: [] }; },
          async run() { throw new Error("a preimage read attempted a write"); },
        };
      },
    },
  } as unknown as Env;
}

async function mcp(args: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request("https://1f916.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer verifier-secret" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "verdict_preimage", arguments: args } }),
    }),
    fakeEnv(),
  );
  const payload = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const text = payload.result?.content?.[0]?.text ?? "{}";
  return { isError: payload.result?.isError === true, body: JSON.parse(text) as { preimage?: string; issued_at?: number; error?: string } };
}

async function http(query: string) {
  const response = await worker.fetch(
    new Request(`https://1f916.ai/api/listings/23/verdict-preimage?${query}`, { headers: { Authorization: "Bearer verifier-secret" } }),
    fakeEnv(),
  );
  return { status: response.status, body: (await response.json()) as { preimage?: string; issued_at?: number; error?: string } };
}

const REFUSAL = "verdict must be 'pass' or 'fail'";

test("MCP verdict_preimage builds the literal it was sent, for both literals", async () => {
  const fail = await mcp({ listing_id: 23, submission_id: 518, verdict: "fail", issued_at: 1789530482141 });
  assert.equal(fail.isError, false);
  assert.equal(fail.body.preimage?.includes(":verifier:fail:3:1789530482141"), true, fail.body.preimage);
  const pass = await mcp({ listing_id: 23, submission_id: 518, verdict: "pass", issued_at: 1789530482141 });
  assert.equal(pass.body.preimage?.includes(":verifier:pass:3:1789530482141"), true, pass.body.preimage);
  assert.notEqual(fail.body.preimage, pass.body.preimage);
});

test("MCP verdict_preimage refuses every spelling that is not one of the two literals, instead of reading it as pass", async () => {
  for (const verdict of ["FAIL", "Fail", "failed", "PASS", "", " fail", "fail ", 0, 1, false, null, undefined]) {
    const r = await mcp({ listing_id: 23, submission_id: 518, verdict, issued_at: 1789530482141 });
    assert.equal(r.isError, true, `verdict ${JSON.stringify(verdict)} must be refused`);
    assert.equal(r.body.preimage, undefined, `verdict ${JSON.stringify(verdict)} must build no preimage`);
    assert.ok(r.body.error?.startsWith(REFUSAL), `refusal names the rule: ${r.body.error}`);
  }
});

test("both doors refuse a non-literal verdict with the same sentence", async () => {
  const viaHttp = await http("verdict=FAIL&submission_id=518&issued_at=1789530482141");
  const viaMcp = await mcp({ listing_id: 23, submission_id: 518, verdict: "FAIL", issued_at: 1789530482141 });
  assert.equal(viaHttp.status, 400);
  assert.ok(viaHttp.body.error?.startsWith(REFUSAL), viaHttp.body.error);
  assert.ok(viaMcp.body.error?.startsWith(REFUSAL), viaMcp.body.error);
});

test("both doors build the same bytes for the same literal and issued_at", async () => {
  const viaHttp = await http("verdict=fail&submission_id=518&issued_at=1789530482141");
  const viaMcp = await mcp({ listing_id: 23, submission_id: 518, verdict: "fail", issued_at: 1789530482141 });
  assert.equal(viaHttp.status, 200);
  assert.equal(viaMcp.body.preimage, viaHttp.body.preimage);
  assert.equal(viaMcp.body.issued_at, viaHttp.body.issued_at);
});

test("issued_at: absent is now on both doors; present and unreadable is refused on both, never replaced", async () => {
  const before = Date.now();
  const absentMcp = await mcp({ listing_id: 23, submission_id: 518, verdict: "fail" });
  const absentHttp = await http("verdict=fail&submission_id=518");
  for (const r of [absentMcp.body, absentHttp.body]) {
    assert.ok(typeof r.issued_at === "number" && r.issued_at >= before && r.issued_at <= Date.now(), `absent issued_at defaults to now: ${r.issued_at}`);
  }
  for (const bad of ["1.5", "-1", "soon", "1e3"]) {
    const m = await mcp({ listing_id: 23, submission_id: 518, verdict: "fail", issued_at: bad });
    const h = await http(`verdict=fail&submission_id=518&issued_at=${encodeURIComponent(bad)}`);
    assert.equal(m.isError, true, `MCP issued_at ${bad} refused`);
    assert.equal(h.status, 400, `HTTP issued_at ${bad} refused`);
    assert.ok(m.body.error?.startsWith("issued_at must be"), m.body.error);
    assert.ok(h.body.error?.startsWith("issued_at must be"), h.body.error);
  }
  // The MCP schema types issued_at as a number; a JSON number of canonical
  // digits is the same value on both doors.
  const numeric = await mcp({ listing_id: 23, submission_id: 518, verdict: "fail", issued_at: 1789530482141 });
  assert.equal(numeric.body.issued_at, 1789530482141);
});
