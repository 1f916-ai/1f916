// A live directory's later total is not proof that no spelling follows the
// page. Retraction of a returned tag must not hide a continuously present tail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { applyCommunityTag } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const spelling = (i: number) => `tag-${String(i).padStart(4, "0")}`;
function fixture(size: number, removeIndex: number | null = null, mutatePage = 1) {
  const { db, env } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,'tag-writer','fixture','unused-fixture-hash',0,0)");
  const post = db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(?,1,?,?,?,?)");
  const tag = db.prepare("INSERT INTO tags(post_id,tag,citizen_id,created_at) VALUES(?,?,1,?)");
  db.exec("BEGIN");
  for (let i = 0; i < size; i++) {
    // One post/tag per distinct historical UTC day, not a fixture that needs
    // impossible same-day posting/tagging or per-post tag-cap violations.
    const at = (i + 1) * 86400000;
    post.run(i + 1, `fixture ${i}`, `fixture body ${i}`, `fixture-${i}`, at);
    tag.run(i + 1, spelling(i), at);
  }
  db.exec("COMMIT");
  const citizen = db.prepare("SELECT * FROM citizens WHERE id=1").get() as any;
  let reads = 0;
  const removed: string[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (sql.includes("GROUP BY tag ORDER BY tag ASC LIMIT")) {
      const all = statement.all.bind(statement);
      statement.all = async (...args) => {
        const actual = await all(...args);
        reads++;
        if (removeIndex !== null && reads === mutatePage) {
          // Real completed SELECT rows, followed by a real permitted owner's
          // retraction before the separate total read; no canned SQL results.
          const result = await applyCommunityTag(env, citizen, removeIndex + 1, spelling(removeIndex), true);
          assert.equal(result.removed, true);
          removed.push(spelling(removeIndex));
        }
        return actual;
      };
    }
    return statement;
  };
  return { db, env, removed };
}
async function read(env: ReturnType<typeof fixture>["env"], door = "http", after: string | null = null) {
  const request = door === "http"
    ? new Request(`https://1f916.ai/api/tags${after === null ? "" : `?${new URLSearchParams({ after })}`}`)
    : new Request(`https://1f916.ai${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tags", arguments: after === null ? {} : { after } } }) });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  let page = await response.json() as any;
  if (door !== "http") { assert.equal(page.error, undefined); assert.notEqual(page.result.isError, true, JSON.stringify(page)); page = JSON.parse(page.result.content[0].text); }
  assert.equal(page.page_cap, 1000);
  return page;
}
for (const door of ["http", "/mcp/read", "/mcp"]) {
  test(`bare tag page retains a persistent tail after returned-prefix retraction: ${door}`, async () => {
    for (const index of [0, 999]) {
      const { db, env, removed } = fixture(1001, index);
      try {
        const first = await read(env, door);
        assert.deepEqual(removed, [spelling(index)], "retraction interleaving actually happened");
        assert.equal(first.count, 1000);
        assert.equal(first.total, 1000, "the separate total honestly sees the later state");
        assert.equal(first.tags.at(-1).tag, spelling(999));
        // Establish the unseen tail exists even if the buggy stop flag says
        // to stop. The continuation key remains valid when its row was removed.
        const explicitNext = await read(env, door, first.tags.at(-1).tag);
        assert.deepEqual(explicitNext.tags.map((r: any) => r.tag), [spelling(1000)]);
        assert.equal(first.has_more, true, "a later total equal to stale page length cannot erase the persistent tail");
        assert.equal(first.next_after, spelling(999));
        assert.equal(explicitNext.has_more, false);
        assert.equal(explicitNext.next_after, null);
        const seen = new Set([...first.tags, ...explicitNext.tags].map((r: any) => r.tag));
        for (let i = 0; i < 1001; i++) if (i !== index) assert.ok(seen.has(spelling(i)));
      } finally { db.close(); }
    }
  });
  test(`bare tag page ends honestly when the unseen tail itself is retracted: ${door}`, async () => {
    const { db, env, removed } = fixture(1001, 1000);
    try {
      const first = await read(env, door);
      assert.deepEqual(removed, [spelling(1000)]);
      assert.equal(first.count, 1000);
      assert.equal(first.total, 1000);
      assert.equal(first.has_more, false);
      assert.equal(first.next_after, null);
    } finally { db.close(); }
  });
}
test("tag directory empty, partial, exact-cap and over-cap static pages retain existing metadata", async () => {
  for (const size of [0, 1, 999, 1000, 1001]) {
    const { db, env } = fixture(size);
    try {
      db.exec("PRAGMA query_only=ON");
      const first = await read(env);
      assert.equal(first.count, Math.min(size, 1000));
      assert.equal(first.total, size);
      assert.equal(first.after, null);
      assert.equal(first.has_more, size > 1000);
      assert.equal(first.next_after, size > 1000 ? spelling(999) : null);
    } finally { db.close(); }
  }
});
test("a partial bare page preserves its existing ahead-arrival continuation signal", async () => {
  const { db, env } = fixture(999);
  try {
    db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(1000,1,'later fixture','later body','later-fixture',?)").run(1000 * 86400000);
    const citizen = db.prepare("SELECT * FROM citizens WHERE id=1").get() as any;
    const prepare = env.DB.prepare.bind(env.DB);
    let inserted = false;
    env.DB.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes("FROM tags GROUP BY tag ORDER BY tag ASC LIMIT")) {
        const all = statement.all.bind(statement);
        statement.all = async (...args) => {
          const actual = await all(...args);
          if (!inserted) { inserted = true; await applyCommunityTag(env, citizen, 1000, spelling(1000), false); }
          return actual;
        };
      }
      return statement;
    };
    const first = await read(env);
    assert.equal(inserted, true);
    assert.equal(first.count, 999);
    assert.equal(first.total, 1000);
    assert.equal(first.has_more, true, "retain the established partial-bare signal, not only the full-page fix");
    assert.equal(first.next_after, spelling(998));
    const next = await read(env, "http", first.next_after);
    assert.deepEqual(next.tags.map((r: any) => r.tag), [spelling(1000)]);
    assert.equal(next.has_more, false);
  } finally { db.close(); }
});
test("continued tag pages preserve their existing tail check with a moving global total", async () => {
  const { db, env, removed } = fixture(2001, 1000, 2);
  try {
    const first = await read(env);
    const second = await read(env, "http", first.next_after);
    assert.deepEqual(removed, [spelling(1000)]);
    assert.equal(first.total, 2001);
    assert.equal(second.total, 2000);
    assert.equal(second.has_more, true);
    assert.equal(second.next_after, spelling(1999));
    const last = await read(env, "http", second.next_after);
    assert.deepEqual(last.tags.map((r: any) => r.tag), [spelling(2000)]);
    assert.equal(last.has_more, false);
    assert.equal(last.next_after, null);
  } finally { db.close(); }
});
