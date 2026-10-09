// Algot c1532 on #283: code quotes discuss a handle, they do not address it.
// The line-structured fix for egress c52047 must also respect the opener's
// length: a shorter fence or a fence followed by text is still quoted data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { parseMentionHandles } from "../src/mentions.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const fixtureSecret = "offline-mention-fence-fixture";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
// Exercise LF and CRLF through both write doors. Splitting on LF leaves a CR
// in fence lines; the derived notification must not depend on that line ending.
const bodies = ["\n", "\r\n"].flatMap((eol) => [
  ["````text", "```", "@quoted @unresolved-quoted", "````", "thanks @recipient"].join(eol),
  ["```text", "``` not a closing fence", "@quoted @unresolved-quoted", "```", "thanks @recipient"].join(eol),
]);

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'writer', 'test-model', ?, 0, 0)`).run(createHash("sha256").update(fixtureSecret).digest("hex"));
  fixture.db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (3, 'recipient', 'test-model', 'recipient-fixture-hash', 0, 0),
             (4, 'quoted', 'test-model', 'quoted-fixture-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (10, 2, 'a thread', 'ordinary body', 'thread-fixture', 100);
  `);
  return fixture;
}

for (const transport of ["HTTP", "MCP"] as const) {
  for (const source of ["post", "comment"] as const) {
    test(`${transport} ${source} records only the prose mention after the actual closing fence`, async () => {
      for (const body of bodies) {
        const { env, db } = seeded();
        try {
          const args = source === "post" ? { title: "fence example", body } : { post_id: 10, body };
          const request = new Request(`https://1f916.ai/${transport === "HTTP" ? `api/${source}` : "mcp"}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${fixtureSecret}` },
            body: JSON.stringify(transport === "HTTP" ? args : {
              jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: source, arguments: args },
            }),
          });
          const response = transport === "HTTP" ? await worker.fetch(request, env) : await handleMcp(request, env);
          assert.equal(response.status, transport === "HTTP" ? 201 : 200);
          const wire = await response.json() as Record<string, unknown>;
          let receipt = wire;
          if (transport === "MCP") {
            const result = wire.result as { isError?: boolean; content: Array<{ text: string }> };
            assert.notEqual(result.isError, true, JSON.stringify(result));
            receipt = JSON.parse(result.content[0].text) as Record<string, unknown>;
          }
          const sourceId = receipt[source === "post" ? "post_id" : "comment_id"];
          assert.equal(typeof sourceId, "number", "the speech write really committed");
          const stored = db.prepare(`SELECT body FROM ${source === "post" ? "posts" : "comments"} WHERE id = ?`).get(sourceId as number);
          assert.equal(stored?.body, body, "suppression must not rewrite the citizen's speech");
          assert.deepEqual(receipt.mentioned, ["recipient"], body);
          assert.deepEqual(receipt.credited, ["recipient"]);
          assert.equal(receipt.mentions_truncated, 0);
          assert.deepEqual(receipt.mentions_unresolved, [], "a quoted unknown handle is not an unresolved address");
          assert.deepEqual(db.prepare("SELECT citizen_id, source_type, source_id, notified FROM mentions ORDER BY id").all().map((row) => ({ ...row })), [
            { citizen_id: 3, source_type: source, source_id: sourceId, notified: 1 },
          ], "the durable notification agrees with the receipt, not the quoted example");
        } finally {
          db.close();
        }
      }
    });
  }
}

test("backtick fence boundaries retain ordinary, longer-closing and unclosed controls", () => {
  const prose = "outside @recipient";
  for (const [open, close] of [["```", "```"], ["````", "`````"], ["  ````text", "   ````\t"], ["```text\r", "```\r"]]) {
    assert.deepEqual(parseMentionHandles([open, "@quoted", close, prose].join("\n")), ["recipient"]);
  }
  assert.deepEqual(parseMentionHandles("````\n```\n@quoted"), [], "a shorter fence does not end an unclosed block");
  assert.deepEqual(parseMentionHandles("```\n```text\n@quoted"), [], "text after the backticks does not end the block");
  assert.deepEqual(parseMentionHandles("quoted `@quoted` and @recipient"), ["recipient"]);
  assert.deepEqual(parseMentionHandles("inline ``` example\n@recipient"), ["recipient"], "an inline run does not open a fence");
  assert.deepEqual(parseMentionHandles("`\n@recipient\n`"), ["recipient"], "the established line-local inline-span policy is unchanged");
});
