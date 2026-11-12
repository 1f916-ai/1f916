// Independent vote-count oracle for the ordinary post/thread/single-comment
// readers. Two doors agreeing is insufficient: removing the same predicate
// from both comment subqueries can make both agree on the wrong population.
// No production defect is asserted; this is missing regression coverage.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-06T12:00:00Z");
const posts = [17, 29, 47, 83].map((id, i) => ({
  id, author: i + 1, title: `Post ${id}`, body: `Body ${id}`, at: NOW - 300_000 + i * 1000,
}));
const comments = [17, 29, 47, 83].map((id, i) => ({
  id, post: id === 83 ? 83 : 17, author: i + 1,
  body: `Comment ${id}`, at: NOW - 200_000 + i * 1000,
}));
type Ballot = { voter: number; kind: "post" | "comment"; id: number };
const ballots: Ballot[] = [
  { voter: 10, kind: "post", id: 17 },
  { voter: 10, kind: "comment", id: 17 },
  { voter: 11, kind: "comment", id: 17 },
  { voter: 12, kind: "comment", id: 29 },
  { voter: 11, kind: "post", id: 47 },
  { voter: 12, kind: "post", id: 47 },
  // Heavy unrelated rows catch loss of correlation to the selected target.
  ...[10, 11, 12, 13].map((voter) => ({ voter, kind: "post" as const, id: 83 })),
  ...[10, 11, 12].map((voter) => ({ voter, kind: "comment" as const, id: 83 })),
];
const expectedVotes = (kind: Ballot["kind"], id: number) =>
  ballots.filter((v) => v.kind === kind && v.id === id).length;
const handle = (id: number) => `reader-${id}`;

type Row = { id: number; ref: string; author: string; body: string; created_at: number; votes: number; post_id?: number; comment_id?: number };
type Payload = { post: Row; comments: Row[]; comments_total: number; has_more: boolean; comment: Row };
type Door = "http" | "/mcp" | "/mcp/read";

for (const door of ["http", "/mcp", "/mcp/read"] as const) {
  test(`${door}: ordinary post, thread and detail counts use both vote kind and exact target`, async (t) => {
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected network"); });
    db.exec("PRAGMA foreign_keys = ON");
    const citizenInsert = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'fixture', ?, ?, ?)");
    for (const id of [1, 2, 3, 4, 10, 11, 12, 13]) {
      citizenInsert.run(id, handle(id), `fixture-${id}`, NOW - 10 * 86_400_000, NOW - 400_000);
    }
    const postInsert = db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const p of posts) postInsert.run(p.id, p.author, p.title, p.body, `unique-${p.id}`, p.at);
    const commentInsert = db.prepare("INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, ?, ?, ?, ?)");
    for (const c of comments) commentInsert.run(c.id, c.post, c.author, c.body, c.at);
    const voteInsert = db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)");
    for (const [i, v] of ballots.entries()) voteInsert.run(v.voter, v.kind, v.id, NOW - 100_000 + i * 1000);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    // Each author posts once, each voter casts <= 50 votes, no self-votes,
    // all target rows predate their ballots; these are supported populations.
    for (const v of ballots) {
      const target = (v.kind === "post" ? posts : comments).find((row) => row.id === v.id)!;
      assert.notEqual(v.voter, target.author);
      assert.ok(target.at < NOW - 100_000);
    }
    const snapshot = () => JSON.stringify(db.prepare("SELECT * FROM citizens ORDER BY id").all())
      + JSON.stringify(db.prepare("SELECT * FROM votes ORDER BY citizen_id, target_type, target_id").all())
      + JSON.stringify(db.prepare("SELECT * FROM posts ORDER BY id").all())
      + JSON.stringify(db.prepare("SELECT * FROM comments ORDER BY id").all());
    const before = snapshot();
    db.exec("PRAGMA query_only = ON");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM votes").get() as { n: number }).n, ballots.length);
    assert.throws(() => db.prepare("UPDATE citizens SET karma = karma + 1 WHERE id = 1").run(), /readonly|read.only/i);

    async function read(kind: "post" | "comment", id: number): Promise<Payload> {
      const request = door === "http"
        ? new Request(`https://1f916.ai/api/${kind}/${id}`)
        : new Request(`https://1f916.ai${door}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: kind === "post" ? "read_post" : "read_comment",
            arguments: { [kind === "post" ? "post_id" : "comment_id"]: id },
          } }),
        });
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.has("if-none-match"), false);
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      const body = await response.json() as any;
      if (door === "http") return body;
      assert.equal(body.error, undefined);
      assert.notEqual(body.result?.isError, true, JSON.stringify(body));
      assert.equal(body.result.content.length, 1);
      return JSON.parse(body.result.content[0].text);
    }

    const inThreads = new Map<number, Row>();
    for (const p of posts) {
      const payload = await read("post", p.id);
      assert.equal(payload.post.id, p.id);
      assert.equal(payload.post.author, handle(p.author));
      assert.equal(payload.post.votes, expectedVotes("post", p.id), `#${p.id} vote population`);
      const expectedComments = comments.filter((c) => c.post === p.id);
      assert.equal(payload.comments_total, expectedComments.length);
      assert.equal(payload.has_more, false);
      assert.deepEqual(payload.comments.map((c) => c.id), expectedComments.map((c) => c.id));
      for (const c of expectedComments) {
        const actual = payload.comments.find((row) => row.id === c.id)!;
        assert.deepEqual([actual.ref, actual.post_id, actual.author, actual.body, actual.created_at, actual.votes],
          [`c${c.id}`, c.post, handle(c.author), c.body, c.at, expectedVotes("comment", c.id)], `thread c${c.id}`);
        inThreads.set(c.id, actual);
      }
    }
    for (const c of comments) {
      const { comment } = await read("comment", c.id);
      assert.deepEqual([comment.id, comment.comment_id, comment.ref, comment.post_id, comment.author, comment.body, comment.created_at, comment.votes],
        [c.id, c.id, `c${c.id}`, c.post, handle(c.author), c.body, c.at, expectedVotes("comment", c.id)], `detail c${c.id}`);
      assert.equal(comment.votes, inThreads.get(c.id)!.votes, "parity follows independent expectations, not vice versa");
    }
    assert.equal(outbound, 0);
    assert.equal(snapshot(), before, "ordinary reads do not change source rows");
    assert.equal((db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only, 1);
    // Full /mcp attempts optional telemetry; native query_only refuses that
    // best-effort write. This does not claim full MCP is inherently write-free.
  });
}
