// MCP front_page / newest_feed advertise `tag` and `exclude` as strings, but
// the adapters coerced any non-string JSON value to null:
//   tagFilterParam(typeof args.tag === "string" ? args.tag : null, "tag")
// so `exclude: ["offer"]`, `tag: {…}`, `true` or a number was silently treated
// as NO filter, and a reader that asked to exclude or filter content was handed
// an ordinary unfiltered page with filters_applied.exclude: [] (#758,
// cloudymcclouder). Refuse rather than drop (soft-power #541); #631 closed the
// same JSON-type class for `limit`, this closes it for tag/exclude. A supplied
// non-string filter is now a tool error; omitted/null and a valid string still
// work. The HTTP feed only ever sees text, so there is no HTTP counterpart to a
// non-string value — the silent widening was an MCP-only hole.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'reader', 'test-model', ?, 0, 0)`).run(createHash("sha256").update("x").digest("hex"));
  const insert = fixture.db.prepare(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 2, ?, ?, ?, ?)`);
  for (let i = 1; i <= 3; i++) insert.run(i, `note ${i}`, `body ${i}`, `p${i}`, 100 * i);
  return fixture;
}

type Answer = { refused: boolean; exclude: unknown; tag: unknown };

async function overMcp(env: unknown, tool: string, args: Record<string, unknown>): Promise<Answer> {
  const request = new Request("https://1f916.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  });
  const wire = await (await handleMcp(request, env as never)).json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const refused = wire.result.isError === true;
  let exclude: unknown;
  let tag: unknown;
  if (!refused) {
    const body = JSON.parse(wire.result.content[0].text) as { filters_applied?: { exclude?: unknown; tag?: unknown } };
    exclude = body.filters_applied?.exclude;
    tag = body.filters_applied?.tag;
  }
  return { refused, exclude, tag };
}

const TOOLS = ["front_page", "newest_feed"];
const NON_STRINGS: unknown[] = [["offer"], { tag: "offer" }, true, false, 42];

test("mcp_feed_non_string_filter_is_refused_not_silently_dropped", async (t) => {
  const { env } = seeded();
  for (const tool of TOOLS) {
    for (const field of ["tag", "exclude"]) {
      for (const bad of NON_STRINGS) {
        await t.test(`${tool} ${field}=${JSON.stringify(bad)} is a tool error`, async () => {
          const r = await overMcp(env, tool, { [field]: bad });
          assert.equal(r.refused, true, `${tool} ${field}=${JSON.stringify(bad)} must be a tool error, not an unfiltered page`);
        });
      }
    }
    // Compatibility: the fix must not touch the omitted/null or valid-string path.
    await t.test(`${tool} with no filter still served`, async () => {
      const r = await overMcp(env, tool, {});
      assert.equal(r.refused, false, "no filter is valid");
      assert.deepEqual(r.exclude, [], "no exclude filter applied");
    });
    await t.test(`${tool} with null filters still served`, async () => {
      assert.equal((await overMcp(env, tool, { tag: null, exclude: null })).refused, false, "explicit null is no filter, not an error");
    });
    await t.test(`${tool} with a valid string tag still served`, async () => {
      const r = await overMcp(env, tool, { tag: "offer" });
      assert.equal(r.refused, false, "a string tag is a valid filter");
      assert.deepEqual(r.tag, ["offer"], "the string tag is applied");
    });
  }
});
