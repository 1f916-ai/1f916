// Siblings of the #758 feed-filter hole (WQ-MCP-SILENT-DROP-SIBLINGS, from the
// #758 deploy audit). The attestations tool's subject/issuer/class and the
// events tool's kind were read as `typeof args.X === "string" ? args.X : null`,
// so a non-string JSON value (array, object, boolean, number) was silently
// coerced to null = NO filter, and a reader that asked to filter was handed a
// WIDER unfiltered result. Reproduced live 2026-11-09: attestations {subject:
// ["x"]} served 200 rows; events {kind: 123} served every kind.
//
// Now stringQueryArg refuses a supplied non-string with a 400 tool error;
// omitted/null and a valid string are unchanged. The `log` selector already
// refused a non-string via assertLog(null), so it is not in scope here.
//
// Killing mutation: revert either tool's filter args to the old
// `typeof args.X === "string" ? args.X : null` coercion -> the refusal cases go
// green-served instead of refused, and the `_is_refused_` tests go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  // A citizen so the read tools have a well-formed registry to answer over; the
  // refusal cases throw before any query, the served cases return empty lists.
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'reader', 'test-model', ?, 0, 0)`).run(createHash("sha256").update("x").digest("hex"));
  return fixture;
}

async function overMcp(env: unknown, tool: string, args: Record<string, unknown>): Promise<boolean> {
  const request = new Request("https://1f916.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const wire = await (await handleMcp(request, env as never)).json() as { result: { isError?: boolean } };
  return wire.result.isError === true; // refused?
}

const NON_STRINGS: unknown[] = [["x"], { a: 1 }, true, false, 42];
// One filter arg at a time (a non-string throws before the query; a single valid
// string is a single-filter query) — never the combined-filter scan shapes. The
// third element is a WELL-FORMED value for the happy path: `class` is validated
// against an enum downstream, so an arbitrary "x" would be refused by that check
// (correctly) rather than by the string-type coercion this test is about.
const CASES: Array<[string, string, string]> = [
  ["attestations", "subject", "reader"],
  ["attestations", "issuer", "reader"],
  ["attestations", "class", "correction"],
  ["events", "kind", "attestation"],
];

test("mcp_query_non_string_filter_is_refused_not_silently_dropped", async (t) => {
  const { env } = seeded();
  for (const [tool, arg] of CASES) {
    for (const bad of NON_STRINGS) {
      await t.test(`${tool}.${arg} = ${JSON.stringify(bad)}`, async () => {
        assert.equal(await overMcp(env, tool, { [arg]: bad }), true, "a non-string filter must be refused, not dropped");
      });
    }
  }
});

test("mcp_query_omitted_and_valid_string_filters_still_work", async (t) => {
  const { env } = seeded();
  for (const [tool, arg, good] of CASES) {
    await t.test(`${tool} with no ${arg} filter is served`, async () => {
      assert.equal(await overMcp(env, tool, {}), false, "omitting the filter still serves a page");
    });
    await t.test(`${tool}.${arg} = ${JSON.stringify(good)} (valid string) is served`, async () => {
      assert.equal(await overMcp(env, tool, { [arg]: good }), false, "a valid string filter still serves");
    });
    await t.test(`${tool}.${arg} = null is served`, async () => {
      assert.equal(await overMcp(env, tool, { [arg]: null }), false, "an explicit null means no filter, served");
    });
  }
});
