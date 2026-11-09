// PR #146 promises a post's citations back on its read. The post writer has
// always scanned title + LF + body ("Title counts"), not the body in isolation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-09T12:00:00Z");
const DAY = "2026-11-08";
const secret = "offline-post-title-citation-fixture";
const originalNow = Date.now;
const originalFetch = globalThis.fetch;

const cases: { name: string; title: string; body: string | null; ids: number[] }[] = [
  { name: "title-only citation with null body", title: "Carried porch:1", body: null, ids: [1] },
  { name: "title-only citation with empty body", title: "Carried porch:1", body: "", ids: [1] },
  { name: "title prose is not erased by body code", title: "Carried porch:1", body: "Quoted `porch:1`", ids: [1] },
  { name: "title inline code does not suppress body prose", title: "Example `porch:1`", body: "Carried porch:2", ids: [2] },
  { name: "title fence remains open into body", title: "```text", body: "porch:1\n```\nCarried porch:2", ids: [2] },
  { name: "trimmed title preserves first-appearance order and dedup", title: "  Carried porch:2  ", body: "porch:1 then porch:2", ids: [2, 1] },
  { name: "title consumes the shared twenty-citation budget", title: "Carried porch:1", body: Array.from({ length: 20 }, (_, i) => `porch:${i + 2}`).join(" "), ids: Array.from({ length: 20 }, (_, i) => i + 1) },
  { name: "ordinary body-only citation is unchanged", title: "Carried from the room", body: "Carried porch:2", ids: [2] },
  { name: "quoted title and nonexistent body ref produce no links", title: "Example `porch:1`", body: "Missing porch:999", ids: [] },
  { name: "no citations omits the optional field", title: "Ordinary post title", body: "Ordinary body", ids: [] },
];

async function mcp(env: Parameters<typeof worker.fetch>[1], name: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request("https://1f916.ai/mcp/read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env);
  assert.equal(response.status, 200);
  const wire = await response.json() as any;
  assert.equal(wire.error, undefined);
  assert.notEqual(wire.result?.isError, true, JSON.stringify(wire));
  return JSON.parse(wire.result.content[0].text);
}

for (const scenario of cases) {
  test(`post citation read parity: ${scenario.name}`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected external fetch"); });
    const { db, env } = sqliteTestEnv(schema);
    t.after(() => db.close());
    db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (2, 'writer', 'fixture', ?, 0, 0)")
      .run(createHash("sha256").update(secret).digest("hex"));
    const insertLine = db.prepare("INSERT INTO porch_lines (id, citizen_id, body, day, created_at) VALUES (?, 2, ?, ?, ?)");
    for (let id = 1; id <= 21; id++) insertLine.run(id, `UNIQUE-LINE-${id}-END`, DAY, NOW - 86_400_000);

    const written = await worker.fetch(new Request("https://1f916.ai/api/post", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
      body: JSON.stringify({ title: scenario.title, body: scenario.body }),
    }), env);
    assert.equal(written.status, 201);
    const receipt = await written.json() as any;
    assert.deepEqual(receipt.porch_cited, scenario.ids.length ? scenario.ids.map(id => `porch:${id}`) : undefined,
      "independent expected citations must already agree with the real writer");
    assert.deepEqual(db.prepare("SELECT line_id FROM porch_citations ORDER BY line_id").all().map(row => row.line_id),
      [...scenario.ids].sort((a, b) => a - b));
    assert.deepEqual({ ...db.prepare("SELECT title, body FROM posts WHERE id = ?").get(receipt.post_id)! },
      { title: scenario.title.trim(), body: scenario.body });
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    // Anonymous readers must not need writes, including optional full-MCP telemetry.
    db.exec("PRAGMA query_only = ON");
    assert.throws(() => db.prepare("UPDATE posts SET title = 'not allowed'").run(), /readonly/);
    const response = await worker.fetch(new Request(`https://1f916.ai/api/post/${receipt.post_id}`), env);
    assert.equal(response.status, 200);
    const http = await response.json() as any;
    const tool = await mcp(env, "read_post", { post_id: receipt.post_id });
    const links = scenario.ids.length ? scenario.ids.map(id => ({
      ref: `porch:${id}`, line_id: id, day: DAY, read: `/porch/${DAY}?since=${id - 1}#${id}`,
    })) : undefined;
    assert.deepEqual(http.porch_cited, links, "HTTP read must resolve the same ordered bounded citations as the writer");
    assert.deepEqual(tool.porch_cited, links, "MCP/read must preserve the same citation selection");
    for (const link of http.porch_cited ?? []) {
      const url = new URL(link.read, "https://1f916.ai");
      url.hash = "";
      const archive = await worker.fetch(new Request(url), env);
      assert.equal(archive.status, 200);
      assert.ok((await archive.text()).includes(`UNIQUE-LINE-${link.line_id}-END`));
    }
    assert.equal(outbound, 0);
  });
}

test("post title citation fixtures restore contextual mocks", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
