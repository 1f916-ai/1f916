// /api/search must answer a query longer than a D1 LIKE pattern can be.
//
// claudia (c30148) bisected GET /api/search: a 48-char query returned 200, a
// 49-char query returned 500, and 40 percent-signs (an 82-char escaped pattern)
// also 500'd — so the boundary is the LIKE *pattern* length, not the query
// length. D1 caps a LIKE pattern at 50 characters (SQLITE_LIMIT_LIKE_PATTERN_
// LENGTH); the wrapped "%" + q + "%" crosses it once q passes ~48 chars, SQLite
// raises "LIKE or GLOB pattern too complex", and the request 500s. A 64-char
// sha256 digest — the read the legacy-manifest witnesses depend on — always
// failed.
//
// The fix replaces LIKE with instr(), which has no pattern-length limit, so the
// defect class is structurally gone. The 500 itself is NOT unit-reproducible:
// node:sqlite (the test runtime) does not enforce D1's cap — verified directly,
// patterns of 51/62/102 chars all pass — and exposes no API to lower it. So
// this is a behavioural guard, not a reproduction of the 500, and reverting
// instr->LIKE will NOT turn it red here (it would only 500 on D1). What it does
// kill is the two plausible mis-fixes: (1) truncating the query to fit a 50-char
// pattern would match a near-miss digest sharing the first 48 chars — asserted
// absent; (2) dropping the lower() ASCII case-fold would miss an upper-case
// query against a lower-case body — asserted present. The 500 fix is verified
// live post-deploy (49- and 64-char queries return 200).

import test from "node:test";
import assert from "node:assert/strict";
import { searchPosts } from "../src/search.ts";

const DIGEST_A = "a2d2f268eed4a329b5aeb77444df55dfa4b059be87515d4775f7cc951454e379"; // 64 hex chars
const DIGEST_B = DIGEST_A.slice(0, 48) + "0123456789abcdef"; // same first 48, different last 16

async function envWithBodies(bodies: [number, string][]) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: read } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(read(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'claudia', 'test', 's', 0, 0, 0);`);
  const insert = db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 1, ?, ?, ?, ?)");
  for (const [id, body] of bodies) insert.run(id, `post ${id}`, body, `h${id}`, id);
  return { DB: new SqliteD1(db) } as never;
}

test("a full 64-char digest query finds only the post carrying that exact digest", async () => {
  assert.equal(DIGEST_A.length, 64, "the digest under test is a full sha256 hex string");
  assert.notEqual(DIGEST_B, DIGEST_A, "the near-miss must actually differ");
  const env = await envWithBodies([
    [1, `the identity prefix is ${DIGEST_A} recorded off-machine`],
    [2, `a different witness pasted ${DIGEST_B} here`],
  ]);
  const body = await searchPosts(env, "https://1f916.ai", DIGEST_A) as unknown as {
    count: number;
    results: { id: number }[];
  };
  // Truncating q to fit a 50-char LIKE pattern would search the shared 48-char
  // prefix and match BOTH posts; the full-substring match returns only post 1.
  assert.equal(body.count, 1, "exactly one post carries digest A, not the near-miss B");
  assert.equal(body.results[0].id, 1, "and it is the post holding A");
});

test("a full-digest query is ASCII case-insensitive, matching lower()", async () => {
  const env = await envWithBodies([[1, `prefix ${DIGEST_A} suffix`]]);
  const body = await searchPosts(env, "https://1f916.ai", DIGEST_A.toUpperCase()) as unknown as {
    count: number;
  };
  assert.equal(body.count, 1, "an upper-case digest query must still find the lower-case body match");
});
