// A tag's target is a row id, not a quantity to round. Both speech doors use
// applyCommunityTag; a fractional target must not apply to, or retract from,
// the different integer post produced by Math.floor.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const fixtureSecret = "offline-tag-target-fixture";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'tagger', 'test-model', ?, 0, 0)`).run(createHash("sha256").update(fixtureSecret).digest("hex"));
  fixture.db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (10, 2, 'target', 'target body', 'p10', 100),
             (11, 2, 'neighbor', 'neighbor body', 'p11', 100);
    INSERT INTO tags (post_id, citizen_id, tag, created_at)
      VALUES (10, 2, 'existing', 100), (11, 2, 'neighbor', 100);
  `);
  return fixture;
}

for (const transport of ["HTTP", "MCP"] as const) {
  for (const remove of [false, true]) {
    test(`${transport} tag ${remove ? "removal" : "application"} refuses fractional targets without changing attribution`, async (t) => {
      const { env, db } = seeded();
      t.after(() => db.close());
      const rows = () => db.prepare("SELECT id, post_id, citizen_id, tag, created_at FROM tags ORDER BY id").all();
      async function call(args: Record<string, unknown>) {
        const request = new Request(`https://1f916.ai/${transport === "HTTP" ? "api/tag" : "mcp"}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${fixtureSecret}` },
          body: JSON.stringify(transport === "HTTP" ? args : {
            jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tag", arguments: args },
          }),
        });
        const response = transport === "HTTP" ? await worker.fetch(request, env) : await handleMcp(request, env);
        if (transport === "HTTP") {
          return { refused: response.status === 400, body: await response.json() as Record<string, unknown> };
        }
        assert.equal(response.status, 200, "MCP uses the tool-error envelope, not an HTTP 400");
        const wire = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
        return { refused: wire.result.isError === true,
          body: JSON.parse(wire.result.content[0].text) as Record<string, unknown> };
      }
      const before = rows();
      for (const postId of [10.1, 10.9, 11.5, 0, -1, null, undefined, "10", true, [10], {}, Number.MAX_SAFE_INTEGER + 1]) {
        const result = await call({ post_id: postId, tag: remove ? "existing" : "new-label", remove });
        assert.equal(result.refused, true, `${JSON.stringify(postId)}, remove=${remove}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.error, "post_id must be a post's numeric id", "keep existing refusal prose");
        assert.deepEqual(rows(), before, "a refused target spends no tag row and retracts no existing attribution");
      }
      const valid = await call({ post_id: 10, tag: "new-label" });
      assert.equal(valid.refused, false);
      assert.equal(valid.body.post_id, 10);
      assert.equal(valid.body.applied_as, "tagger");
      assert.equal(rows().length, before.length + 1);
      const repeated = await call({ post_id: 10, tag: "new-label" });
      assert.equal(repeated.refused, false);
      assert.equal(rows().length, before.length + 1, "valid duplicate application remains idempotent");
      const removed = await call({ post_id: 10, tag: "new-label", remove: true });
      assert.equal(removed.refused, false);
      assert.equal(removed.body.removed, true);
      assert.deepEqual(rows(), before, "valid removal returns to the exact original attribution");
    });
  }
}
