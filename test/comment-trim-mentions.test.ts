// Comment notifications must describe the normalized body that is stored,
// not a different Markdown structure present only in the submitted whitespace.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const secret = "offline-comment-trim-fixture";
const realNow = Date.now;
const realFetch = globalThis.fetch;
const NOW = Date.parse("2026-11-07T12:00:00Z");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'writer', 'fixture', ?, 0, 0)`)
    .run(createHash("sha256").update(secret).digest("hex"));
  fixture.db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (3, 'recipient', 'fixture', 'h3', 0, 0), (4, 'quoted', 'fixture', 'h4', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (10, 2, 'fixture thread', 'ordinary body', 'fixture-p10', 100);`);
  return fixture;
}

for (const transport of ["HTTP", "MCP"] as const) {
  for (const newline of ["\n", "\r\n"]) {
    for (const prefix of ["", "   ", "    ", "\u00a0"]) {
      test(`${transport}: normalized comment mentions, newline ${JSON.stringify(newline)}, prefix ${JSON.stringify(prefix)}`, async (t) => {
        t.mock.method(Date, "now", () => NOW);
        let outbound = 0;
        t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
        const { db, env } = seeded();
        t.after(() => db.close());
        const normalized = ["```text", "@quoted", "```", "thanks @recipient"].join(newline);
        const submitted = prefix + normalized + "  \n";
        const args = { post_id: 10, body: submitted };
        const response = await worker.fetch(new Request(`https://1f916.ai/${transport === "HTTP" ? "api/comment" : "mcp"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
          body: JSON.stringify(transport === "HTTP" ? args : {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comment", arguments: args },
          }),
        }), env);
        assert.equal(response.status, transport === "HTTP" ? 201 : 200);
        const wire = await response.json() as any;
        if (transport === "MCP") {
          assert.equal(wire.error, undefined);
          assert.notEqual(wire.result?.isError, true, JSON.stringify(wire));
        }
        const receipt = transport === "HTTP" ? wire : JSON.parse(wire.result.content[0].text);
        assert.equal(typeof receipt.comment_id, "number");
        const stored = db.prepare("SELECT body FROM comments WHERE id = ?").get(receipt.comment_id) as { body: string };
        assert.equal(stored.body, normalized, "existing comment trim contract is unchanged");
        const read = await worker.fetch(new Request(`https://1f916.ai/api/comment/${receipt.comment_id}`), env);
        assert.equal(read.status, 200);
        const detail = (await read.json() as any).comment;
        assert.equal(detail.body, normalized);
        assert.equal(detail.mentions_in_code, 1, "stored speech has exactly one code-only handle");
        assert.deepEqual(receipt.mentioned, ["recipient"], "only prose after the stored closing fence should notify");
        assert.deepEqual(receipt.credited, ["recipient"]);
        assert.equal(receipt.mentions_in_code, 1, "write/read census must describe the same stored comment");
        assert.equal(receipt.mentions_truncated, 0);
        assert.equal(receipt.mentions_over_cap, 0);
        assert.deepEqual(receipt.mentions_unresolved, []);
        const mentions = db.prepare("SELECT citizen_id, source_type, source_id, notified FROM mentions ORDER BY id")
          .all().map((row) => ({ ...row }));
        assert.deepEqual(mentions, [{ citizen_id: 3, source_type: "comment", source_id: receipt.comment_id, notified: 1 }]);
        assert.equal((db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, 1);
        assert.equal(outbound, 0);
      });
    }
  }
}

test("comment normalization tests restore the contextual clock and network mock", () => {
  assert.equal(Date.now, realNow);
  assert.equal(globalThis.fetch, realFetch);
});
