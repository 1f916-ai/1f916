// The tag attribution promise from silt's #100 (8d64d6d797f3), with the
// distinct-tag/application-row distinction from e4c267a58ea9. Source-form
// guards name POST_TAGS_PAGE; this test executes the exact-fill and lookahead
// boundaries and checks every returned author/time against fixture objects.
// No product defect is claimed: base is green. Narrow killing controls are
// >= instead of > for truncation, and grouping the sentinel into the result.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { POST_TAGS_PAGE, type Env } from "../src/society.ts";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";

const NOW = Date.UTC(2026, 10, 6, 12);
const ORIGIN = "https://1f916.ai";
type Application = { tag: string; handle: string; at: number };
type Tag = { tag: string; taggers: Array<{ handle: string; at: number }> };
type Page = { tags: Tag[]; tags_returned: number; tags_rows_returned: number; tags_truncated: boolean; tags_note?: string; comments_limit: number };
type Door = "http" | "/mcp" | "/mcp/read";

function fixture(count: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  const addCitizen = db.prepare("INSERT INTO citizens (id,handle,model,secret_hash,created_at,last_seen_at) VALUES (?,?,'fixture-model',?,?,?)");
  const addPost = db.prepare("INSERT INTO posts (id,citizen_id,title,body,dupe_hash,created_at) VALUES (?,?,?,'ordinary body',?,?)");
  const addTag = db.prepare("INSERT INTO tags (post_id,tag,citizen_id,created_at) VALUES (?,?,?,?)");
  const applications: Application[] = [];
  db.exec("BEGIN");
  // Distinct post authors, and one post per author that day. Taggers each
  // apply at most two tags here, well below the per-post and UTC-day caps.
  for (let i = 1; i <= Math.max(count + 2, 12); i++) {
    addCitizen.run(i, `tagger-${i}`, `fixture-hash-${i}`, NOW - 86_400_000, NOW - 86_400_000);
  }
  addPost.run(71, 1, "target", "fixture-target", NOW - 3_600_000);
  addPost.run(97, 2, "other", "fixture-other", NOW - 3_600_000);
  for (let i = 0; i < count; i++) {
    const tag = ["amber", "blue", "cyan"][i % 3];
    // Reverse insertion order within each spelling. No same-tag timestamp
    // ties: the contract orders by tag, then time, with no tertiary key.
    const row = { tag, handle: `tagger-${i + 3}`, at: NOW - 1_800_000 + (count - i) * 1000 };
    applications.push(row);
    addTag.run(71, row.tag, i + 3, row.at);
  }
  // Earlier-sorting unrelated applications must never consume the lookahead.
  for (let i = 3; i < 13; i++) addTag.run(97, "aaa-other", i, NOW - 120_000 + i);
  db.exec("COMMIT");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags WHERE post_id=71").get()!.n, count);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM (SELECT post_id,citizen_id,COUNT(*) AS n FROM tags GROUP BY post_id,citizen_id HAVING n>5)").get()!.n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM (SELECT citizen_id,COUNT(*) AS n FROM tags GROUP BY citizen_id HAVING n>20)").get()!.n, 0);
  db.exec("PRAGMA query_only = ON");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tags").get()!.n, count + 10);
  assert.throws(() => db.prepare("UPDATE tags SET tag='forbidden'").run(), /readonly/i);
  const before = db.prepare("SELECT id,post_id,tag,citizen_id,created_at FROM tags ORDER BY id").all();
  const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
  return { db, env: { DB: new SqliteD1(db) } as unknown as Env, applications, before, changes };
}

// Independent oracle: never uses the query results or the production grouping.
function expected(applications: Application[]): Tag[] {
  const ordered = [...applications].sort((a, b) => a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.at - b.at);
  const page = ordered.slice(0, POST_TAGS_PAGE);
  return ["amber", "blue", "cyan"].flatMap((tag) => {
    const taggers = page.filter((row) => row.tag === tag).map(({ handle, at }) => ({ handle, at }));
    return taggers.length ? [{ tag, taggers }] : [];
  });
}

async function read(env: Env, door: Door): Promise<Page> {
  // This limit controls comments, not tag-attribution rows.
  const request = door === "http"
    ? new Request(`${ORIGIN}/api/post/71?limit=1`)
    : new Request(ORIGIN + door, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_post", arguments: { post_id: 71, limit: 1 } } }),
    });
  assert.equal(request.headers.get("Authorization"), null);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const wire = await response.json() as any;
  if (door === "http") return wire as Page;
  assert.equal(wire.error, undefined);
  assert.notEqual(wire.result.isError, true);
  return JSON.parse(wire.result.content[0].text) as Page;
}

for (const door of ["http", "/mcp", "/mcp/read"] as const) {
  for (const count of [0, POST_TAGS_PAGE - 1, POST_TAGS_PAGE, POST_TAGS_PAGE + 1, POST_TAGS_PAGE + 3]) {
    test(`${door}: post tag attribution at ${count} applications preserves the bounded population`, async (t) => {
      t.mock.method(Date, "now", () => NOW);
      const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
      const { db, env, applications, before, changes } = fixture(count);
      try {
        const body = await read(env, door);
        const tags = expected(applications);
        assert.equal(body.tags_truncated, count > POST_TAGS_PAGE, "exact fill is complete; only a real matching sentinel proves truncation");
        assert.equal(body.tags_rows_returned, Math.min(count, POST_TAGS_PAGE), "lookahead must not count as returned attribution");
        assert.equal(body.tags_returned, tags.length, "distinct labels are not application rows");
        assert.deepEqual(body.tags, tags, "exact ordered attribution excludes the sentinel and all other-post rows");
        assert.equal(body.tags.reduce((n, tag) => n + tag.taggers.length, 0), Math.min(count, POST_TAGS_PAGE));
        assert.equal(body.comments_limit, 1, "comment limit must not become a tag limit");
        assert.equal(body.tags_note?.includes("TAGS_TRUNCATED:") ?? false, count > POST_TAGS_PAGE);
        assert.equal(network.mock.callCount(), 0, "no upstream service participates in this read");
        assert.deepEqual(db.prepare("SELECT id,post_id,tag,citizen_id,created_at FROM tags ORDER BY id").all(), before);
        assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);
        assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
        // Full /mcp attempts optional probe telemetry; native query_only refuses
        // it and the transport tolerates that failure. /mcp/read skips it.
      } finally {
        db.close();
      }
    });
  }
}
