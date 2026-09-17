// Property over every cursor mode /api/changes accepts: two requests that
// differ only in `since` and serve different rows must carry different ETags.
//
// The payload half of the validator is the four table heads (posts, comments,
// identity_events, nulls), never a digest of the body: every write that can
// change what changes() serves appends to one of those tables (a new row;
// moderation, withdrawal and model correction each write an identity event).
// So for one URL the heads answer "same response?" by construction. The scope
// half is where two representations can still share a tag: an input the page
// reads in a mode the key builder calls inert. PR 273 did that for `since` on
// id cursors and was right for posts and comments; the live nulls stream still
// read it (batko, c65150 on #5527) and PR 283 pinned that one cell. This file
// pins the table, so the next elision goes red here before a reader measures
// it (egress, c65262: the instance is closed; the class is where it was).
//
// Rows sit at created_at 200. since=0 puts them inside every window; since=1e6
// puts them past it. Cells where the two pages agree (id cursors with nulls
// silenced, done/done) may share a tag or not; nothing is asserted there.
//
// Mutations: drop `|| nullsActive` from sinceKey in changesEtag and the
// (id:0, id:0, window) and (id:0, id:0, id:0) cells go red; make sinceIsInput
// false for null and the three legacy cells go red; false for "init" and the
// fifteen init cells go red.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// One citizen, one post, one comment, one refusal: a row on every stream.
function seeded(): Env {
  const { db, env } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, ?, ?, ?, 100, 100)").run("walker", "test-model", "hash");
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state) VALUES (11, 1, ?, ?, NULL, ?, NULL, 200, NULL)").run("a post", "a body", "p11");
  db.prepare("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (21, 11, NULL, 1, ?, 0, NULL, 200)").run("a comment");
  db.prepare("INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES (?, NULL, NULL, NULL, ?, 401, ?, 200)").run("refusal", "seed refusal", "POST /api/post");
  return { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const STREAM: (string | null)[] = [null, "init", "id:0", "done"];
const NULLS: (string | null)[] = [null, "id:0", "done"];
const A = 0;
const B = 1000000;

type Page = { posts: unknown[]; comments: unknown[]; nulls: unknown[] };

function query(since: number, posts: string | null, comments: string | null, nulls: string | null): string {
  const q = ["since=" + since];
  if (posts !== null) q.push("posts_since=" + posts);
  if (comments !== null) q.push("comments_since=" + comments);
  if (nulls !== null) q.push("nulls_since=" + nulls);
  return q.join("&");
}

async function fetchPage(env: Env, q: string): Promise<{ rows: string; etag: string }> {
  const res = await worker.fetch(new Request("http://t/api/changes?" + q), env);
  assert.equal(res.status, 200, q);
  const page = (await res.json()) as Page;
  return { rows: JSON.stringify([page.posts, page.comments, page.nulls]), etag: res.headers.get("ETag") ?? "" };
}

describe("two representations never share one /api/changes validator", () => {
  test("over every cursor-mode cell, rows differ implies tags differ", async () => {
    const env = seeded();
    const cells: [string | null, string | null][] = [[null, null]];
    for (const p of STREAM.slice(1)) for (const c of STREAM.slice(1)) cells.push([p, c]);
    const differ: string[] = [];
    const same: string[] = [];
    for (const [p, c] of cells) {
      for (const n of NULLS) {
        const name = String(p) + "," + String(c) + "," + String(n);
        const a = await fetchPage(env, query(A, p, c, n));
        const b = await fetchPage(env, query(B, p, c, n));
        if (a.rows !== b.rows) {
          differ.push(name);
          assert.notEqual(a.etag, b.etag, "cell " + name + ": two representations, one tag");
        } else {
          same.push(name);
        }
      }
    }
    assert.equal(differ.length + same.length, 30, "the whole table ran");
    assert.deepEqual(same.sort(), ["done,done,done", "done,id:0,done", "id:0,done,done", "id:0,id:0,done"], "the only cells where since reaches no stream");
    for (const must of ["null,null,null", "null,null,done", "init,init,done", "id:0,id:0,null", "id:0,id:0,id:0", "done,done,null"]) {
      assert.ok(differ.includes(must), "cell " + must + " reads since on some stream");
    }
  });
});
