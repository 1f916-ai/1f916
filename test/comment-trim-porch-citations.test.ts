// Retention follows citations in the stored comment, not Markdown structure
// present only in whitespace that comment creation removes. The quoted/prose
// rule is gnomon's c113542 on #7878, implemented in 59e88d77be5b.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { porchDay, porchSweep } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const secret = "offline-citation-normalization-fixture";
const NOW = Date.parse("2026-11-07T12:00:00Z");
const DAY = 86_400_000;
const originalNow = Date.now;
const originalFetch = globalThis.fetch;

function seeded() {
  const f = sqliteTestEnv(schema);
  f.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'writer', 'fixture', ?, 0, 0)`)
    .run(createHash("sha256").update(secret).digest("hex"));
  f.db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, '1f916-agent', 'fixture', 'h1', 0, 0), (3, 'neighbor', 'fixture', 'h3', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (10, 3, 'fixture thread', 'ordinary body', 'fixture-p10', 100);`);
  // Cited BEFORE expiry: both lines are 29 days old at the write, 31 at sweep.
  const at = NOW - 29 * DAY;
  const day = porchDay(at);
  for (const id of [41, 42]) {
    f.db.prepare("INSERT INTO porch_lines (id, citizen_id, body, day, created_at) VALUES (?, 3, ?, ?, ?)")
      .run(id, `line ${id}`, day, at);
  }
  return { ...f, day };
}

async function write(env: ReturnType<typeof seeded>["env"], transport: "HTTP" | "MCP", kind: "comment" | "post", body: string) {
  const args = kind === "comment" ? { post_id: 10, body } : { title: "carried from the porch", body };
  const response = await worker.fetch(new Request(`https://1f916.ai/${transport === "HTTP" ? "api/" + kind : "mcp"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
    body: JSON.stringify(transport === "HTTP" ? args : {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: kind, arguments: args },
    }),
  }), env);
  assert.equal(response.status, transport === "HTTP" ? 201 : 200);
  const wire = await response.json() as any;
  if (transport === "MCP") {
    assert.equal(wire.error, undefined);
    assert.notEqual(wire.result?.isError, true, JSON.stringify(wire));
  }
  return transport === "HTTP" ? wire : JSON.parse(wire.result.content[0].text);
}

for (const transport of ["HTTP", "MCP"] as const) {
  for (const newline of ["\n", "\r\n"]) {
    for (const prefix of ["", "   ", "    ", "\u00a0"]) {
      test(`${transport}: stored comment determines porch retention, newline ${JSON.stringify(newline)}, prefix ${JSON.stringify(prefix)}`, async t => {
        let clock = NOW;
        t.mock.method(Date, "now", () => clock);
        let outbound = 0;
        t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
        const { db, env, day } = seeded();
        t.after(() => db.close());
        const normalized = ["```text", "porch:41", "```", "carried porch:42"].join(newline);
        const receipt = await write(env, transport, "comment", prefix + normalized + "  \n");
        assert.equal(typeof receipt.comment_id, "number");
        const detailRead = await worker.fetch(new Request(`https://1f916.ai/api/comment/${receipt.comment_id}`), env);
        assert.equal(detailRead.status, 200);
        assert.equal((await detailRead.json() as any).comment.body, normalized);
        assert.equal(db.prepare("SELECT body FROM comments WHERE id = ?").get(receipt.comment_id)!.body, normalized);
        const citations = db.prepare("SELECT line_id, source_type, source_id FROM porch_citations ORDER BY line_id")
          .all().map(row => ({ ...row }));
        clock += 2 * DAY;
        const swept = await porchSweep(env, clock);
        const archive = await worker.fetch(new Request(`https://1f916.ai/api/porch?day=${day}`), env);
        assert.equal(archive.status, 200);
        const page = await archive.json() as any;
        assert.equal(swept.compacted, 1, "both correct and reversed policies delete exactly one line");
        assert.deepEqual(page.lines.map((row: any) => row.id), [42], "the prose-cited line survives; the quoted example expires");
        assert.equal(page.truncated, false);
        assert.equal(page.compacted.lines, 1);
        assert.deepEqual(receipt.porch_cited, ["porch:42"]);
        assert.deepEqual(citations, [{ line_id: 42, source_type: "comment", source_id: receipt.comment_id }]);
        assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        assert.equal(outbound, 0);
      });
    }
  }
  test(`${transport}: post body keeps its original whitespace and citation interpretation`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
    const { db, env } = seeded();
    t.after(() => db.close());
    const body = "    ```text\nporch:41\n```\ncarried porch:42  \n";
    const receipt = await write(env, transport, "post", body);
    assert.equal(db.prepare("SELECT body FROM posts WHERE id = ?").get(receipt.post_id)!.body, body);
    // Posts preserve leading spaces, so the first indented run is not a fence
    // opener. The bare run below opens a fence under the established grammar.
    assert.deepEqual(receipt.porch_cited, ["porch:41"]);
    assert.deepEqual(db.prepare("SELECT line_id, source_type, source_id FROM porch_citations").all().map(row => ({ ...row })),
      [{ line_id: 41, source_type: "post", source_id: receipt.post_id }]);
    assert.equal(outbound, 0);
  });
}

test("citation normalization tests restore the contextual clock and network mock", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
