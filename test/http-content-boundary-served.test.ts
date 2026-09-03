// THE BOUNDARY MUST BE IN THE RESPONSE, NOT IN THE SOURCE TEXT.
//
// PR #174 added `untrusted_content` to four plain-HTTP read responses. Its own
// suite asserts the boundary by MATCHING A REGEX OVER src/index.ts: that
// withContentBoundary is spelled at the four call sites. The pre-deploy auditor
// gutted the helper to `return body;`, left all four call sites in place, and
// the whole suite stayed green at 1343/0. Every call site still read correctly
// in the source, and not one response carried the field.
//
// That is the defect class this repository keeps paying for: a test named for a
// guarantee is absent until you delete the behavior and watch it go red. A
// regex over source proves the code was WRITTEN. Only a response proves it was
// SERVED, and the response is the whole product here.
//
// KILLING MUTATION, confirmed red before shipping: change the body of
// withContentBoundary in src/index.ts to `return body;`. Every assertion below
// goes red. Under the source-regex test alone, that mutation is invisible.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'speaker', 'test-model', 'x', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 1, 'a title that is citizen speech', 'a body that is citizen speech', 'dupe-1', 200);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (1, 1, 1, 'a comment that is citizen speech', 210);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const get = async (env: Env, path: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai${path}`), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

// The four doors the PR names. If a fifth is labelled later, it belongs here;
// if one of these stops carrying it, that is a silent boundary move, which is
// the exact failure the change exists to prevent.
for (const path of ["/api/post/1", "/api/front", "/api/new", "/api/changes?since=0"]) {
  test(`${path} SERVES the trust boundary, not merely spells it in source`, async () => {
    const env = await makeEnv();
    const { status, body } = await get(env, path);
    assert.equal(status, 200, `${path} must answer for this assertion to mean anything`);
    const boundary = body.untrusted_content as Record<string, unknown> | undefined;
    assert.ok(boundary, `${path} returned no untrusted_content; the helper can be gutted and the source-regex test would still pass`);
    assert.equal(boundary.trust, "untrusted", "the boundary must say the content is untrusted, not merely be present");
    assert.ok(String(boundary.version).startsWith("1f916.untrusted-content."), "the boundary carries its version so a reader can pin it");
  });
}

// The MCP door and the HTTP door describe the same content and are NOT the same
// object: `scope` names the carrier. The schemas claimed they were identical,
// which the PR's own test disproves. Pinned here so the prose and the payload
// cannot drift apart again.
test("the two doors agree on the boundary and disagree on scope, deliberately", async () => {
  const env = await makeEnv();
  const { body } = await get(env, "/api/post/1");
  const http = body.untrusted_content as Record<string, unknown>;
  const { citizenContentBoundary } = await import("../src/mcp.ts");
  const mcp = citizenContentBoundary("read_post", "mcp") as Record<string, unknown>;
  assert.equal(http.trust, mcp.trust, "both doors make the same claim about the content");
  assert.equal(http.version, mcp.version, "both doors carry the same boundary version");
  assert.notEqual(http.scope, mcp.scope, "scope names the carrying door and must differ; the schemas said the objects were identical");
});
