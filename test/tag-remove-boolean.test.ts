import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const fixtureSecret = "offline-tag-remove-fixture";

for (const transport of ["HTTP", "MCP"] as const) {
  test(`${transport} tag refuses a non-boolean removal flag without adding attribution or spending quota`, async (t) => {
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (2, 'tagger', 'test-model', ?, 0, 0)`).run(createHash("sha256").update(fixtureSecret).digest("hex"));
    db.exec(`
      INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
        VALUES (10, 2, 'target', 'target body', 'p10', 100),
               (11, 2, 'neighbor', 'neighbor body', 'p11', 100);
      INSERT INTO tags (post_id, citizen_id, tag, created_at)
        VALUES (10, 2, 'existing', 100), (11, 2, 'neighbor', 100);
    `);
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
    const rows = () => db.prepare("SELECT id, post_id, citizen_id, tag, created_at FROM tags ORDER BY id").all();
    const midnight = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const dailyTags = () => db.prepare("SELECT COUNT(*) AS n FROM tags WHERE citizen_id = 2 AND created_at >= ?").get(midnight)!.n;
    const before = rows();
    const quotaBefore = dailyTags();
    for (const remove of ["true", "false", "", 0, 1, null, [], {}]) {
      for (const tag of ["new-label", "existing"]) {
        const result = await call({ post_id: 10, tag, remove });
        assert.equal(result.refused, true, `${JSON.stringify(remove)}, tag=${tag}: ${JSON.stringify(result.body)}; rows=${rows().length}, daily_tags=${dailyTags()}, baseline_rows=${before.length}, baseline_daily_tags=${quotaBefore}`);
        assert.equal(result.body.error, "remove must be a boolean when supplied");
        assert.deepEqual(rows(), before, `invalid remove=${JSON.stringify(remove)} must change no attribution`);
        assert.equal(dailyTags(), quotaBefore, "invalid removal must consume no application quota");
      }
    }
    for (const args of [{ post_id: 10, tag: "new-label" }, { post_id: 10, tag: "another-label", remove: false }]) {
      const added = await call(args);
      assert.equal(added.refused, false);
      assert.equal(added.body.applied_as, "tagger");
    }
    assert.equal(dailyTags(), quotaBefore + 2);
    const repeated = await call({ post_id: 10, tag: "new-label", remove: false });
    assert.equal(repeated.refused, false);
    assert.equal(dailyTags(), quotaBefore + 2, "duplicate application stays idempotent");
    const removed = await call({ post_id: 10, tag: "new-label", remove: true });
    assert.equal(removed.refused, false);
    assert.equal(removed.body.removed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE post_id = 10 AND citizen_id = 2 AND tag = 'new-label'").get()!.n, 0);
    assert.equal(dailyTags(), quotaBefore + 1, "removal adds no row to the existing row-counted quota");
    const absent = await call({ post_id: 10, tag: "new-label", remove: true });
    assert.equal(absent.refused, false);
    assert.equal(absent.body.removed, false, "valid removal stays idempotent");
  });
}
