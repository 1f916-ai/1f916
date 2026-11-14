import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { readComment } from "../src/society.ts";
import { PORCH_CITE_MAX } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ORIGIN = "https://1f916.ai";
const NOW = Date.parse("2026-11-13T12:00:00Z");
const DAY = "2026-11-12";
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const body = "  Carried porch:301 porch:301; example `porch:302`; missing porch:999.  ";
const link = (id: number) => ({ ref: `porch:${id}`, line_id: id, day: DAY, read: `/porch/${DAY}?since=${id - 1}#${id}` });

async function json(response: Response, status = 200): Promise<any> {
  const value = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}

async function fixture(t: any, input = body) {
  t.mock.method(Date, "now", () => NOW);
  let outbound = 0;
  t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("outbound forbidden"); });
  const { db, env } = sqliteTestEnv(schema);
  t.after(() => db.close());
  const secret = "offline-comment-citation-fixture";
  db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (2,'citation-writer','fixture',?,0,0)")
    .run(createHash("sha256").update(secret).digest("hex"));
  db.exec("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (3,'citation-neighbor','fixture','unused',0,0); INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES (10,3,'ordinary thread','body','seeded-thread',100)");
  const insert = db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (?,3,?,?,?)");
  for (const id of [301, 302, ...Array.from({ length: PORCH_CITE_MAX + 2 }, (_, i) => 500 + i)]) {
    insert.run(id, `TARGET-${id}-UNIQUE`, DAY, NOW - 86_400_000);
  }
  const receipt = await json(await worker.fetch(new Request(`${ORIGIN}/api/comment`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ post_id: 10, body: input }),
  }), env), 201);
  const id = receipt.comment_id;
  assert.equal(db.prepare("SELECT body FROM comments WHERE id=?").get(id)!.body, input.trim());
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  const get = (headers: Record<string, string> = {}) => worker.fetch(new Request(`${ORIGIN}/api/comment/${id}`, { headers }), env);
  const mcp = async () => {
    const wire = await json(await worker.fetch(new Request(`${ORIGIN}/mcp/read`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_comment", arguments: { comment_id: id } } }),
    }), env));
    assert.equal(wire.error, undefined);
    assert.notEqual(wire.result.isError, true);
    return JSON.parse(wire.result.content[0].text);
  };
  const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
  db.exec("PRAGMA query_only = ON");
  assert.equal(db.prepare("SELECT 1 AS n").get()!.n, 1);
  assert.throws(() => db.exec("UPDATE comments SET body='denied'"), /readonly/i);
  return { db, env, id, receipt, get, mcp, verify() {
    assert.equal(outbound, 0);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);
  } };
}

// PR #146's retention introduction explicitly promises resolved porch_cited
// on a citing post OR comment's own read. The writer already records these ids.
test("a real comment write resolves its carried line through shared, HTTP and MCP/read readers", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.receipt.porch_cited, ["porch:301"]);
  assert.deepEqual(f.db.prepare("SELECT line_id,source_type,source_id FROM porch_citations").all().map(r => ({ ...r })),
    [{ line_id: 301, source_type: "comment", source_id: f.id }]);
  const response = await f.get();
  const tag = response.headers.get("ETag")!;
  const http = await json(response);
  assert.equal(http.comment.body, body.trim());
  assert.deepEqual(http.porch_cited, [link(301)]);
  assert.deepEqual((await readComment(f.env, f.id)).porch_cited, [link(301)]);
  assert.deepEqual((await f.mcp()).porch_cited, [link(301)]);
  const url = new URL(http.porch_cited[0].read, ORIGIN);
  url.hash = ""; // fragments never select a server-side page
  const target = await worker.fetch(new Request(url), f.env);
  assert.equal(target.status, 200);
  assert.match(await target.text(), /TARGET-301-UNIQUE/);
  const held = await f.get({ "If-None-Match": tag });
  assert.equal(held.status, 304);
  assert.equal(await held.text(), "");
  f.verify();
});

test("comment companions keep parser order/cap, omit code and absent refs, and do not refill missing candidates", async t => {
  const ids = Array.from({ length: PORCH_CITE_MAX + 1 }, (_, i) => 500 + i);
  const f = await fixture(t, `porch:999 ${ids.map(id => `porch:${id}`).join(" ")} porch:500 \`porch:302\``);
  const expected = ids.slice(0, PORCH_CITE_MAX - 1).map(link);
  const http = await json(await f.get());
  assert.deepEqual(http.porch_cited, expected);
  assert.deepEqual((await f.mcp()).porch_cited, expected);
  assert.deepEqual(f.receipt.porch_cited, expected.map(row => row.ref));
  f.verify();
});

test("quoted-only or absent comment citations keep the established optional-field shape", async t => {
  const f = await fixture(t, "Example `porch:302`, missing porch:999, notporch:301.");
  assert.equal(Object.hasOwn(f.receipt, "porch_cited"), false);
  assert.equal(Object.hasOwn(await json(await f.get()), "porch_cited"), false);
  assert.equal(Object.hasOwn(await f.mcp(), "porch_cited"), false);
  f.verify();
});

test("conditional comment reads observe newly resolved targets, without backfilling retention", async t => {
  const f = await fixture(t, "Missing porch:999.");
  const initial = await f.get();
  const tag = initial.headers.get("ETag")!;
  assert.equal(Object.hasOwn(await json(initial), "porch_cited"), false);
  f.verify();
  // A read resolves current targets; it does not turn an earlier missing target
  // into a historical write-time retention receipt.
  f.db.exec("PRAGMA query_only = OFF");
  f.db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (999,3,'late target',?,?)").run(DAY, NOW);
  f.db.exec("PRAGMA query_only = ON");
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  const next = await f.get({ "If-None-Match": tag });
  assert.notEqual(next.headers.get("ETag"), tag);
  assert.deepEqual((await json(next)).porch_cited, [link(999)]);
  assert.deepEqual(f.db.prepare("SELECT * FROM porch_citations").all(), []);
  assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
});

test("contextual clock and outbound mocks are restored", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
