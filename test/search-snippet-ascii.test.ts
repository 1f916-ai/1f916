// Snippet offsets address the original body, whose length need not survive
// Unicode lowercasing. The excerpt must retain the body match SQLite found.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

async function search(body: string, query = "needle", title = "xyz") {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'snippet-fixture', 'test', 'offline-hash', 0, 0)`);
  db.prepare(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 1, ?, ?, 'fixture', 1)`).run(title, body);
  try {
    const response = await worker.fetch(new Request(`https://1f916.ai/api/search?q=${encodeURIComponent(query)}`), env);
    assert.equal(response.status, 200);
    return await response.json() as { count: number; results: Array<{ id: number; snippet: string }> };
  } finally {
    db.close();
  }
}

for (const prefixLength of [81, 100]) {
  test(`search snippet retains a body match after ${prefixLength} lowercase-expanding characters`, async () => {
    const result = await search("İ".repeat(prefixLength) + "needle");
    assert.equal(result.count, 1, "SQLite finds the body match, not the unrelated title");
    assert.equal(result.results[0].id, 1);
    assert.match(result.results[0].snippet, /needle/, "a short matching word must remain visible in its excerpt");
  });
}

test("search snippets preserve ASCII folding, original-case bytes and ASCII-only match semantics", async () => {
  for (const body of ["A".repeat(100) + "NEEDLE", "Ω".repeat(100) + "needle", "needle" + "İ".repeat(100), "İ".repeat(80) + "needle"]) {
    const result = await search(body);
    assert.equal(result.count, 1);
    assert.match(result.results[0].snippet, /needle/i);
    assert.ok(body.includes(result.results[0].snippet.replace(/^…|…$/g, "")), "folding never changes the displayed original case");
  }
  assert.equal((await search("İ".repeat(100), "i")).count, 0, "non-ASCII letters are not case-folded by the search query");
  const unicodeQuery = await search("x".repeat(100) + "İNEEDLE", "İneedle");
  assert.equal(unicodeQuery.count, 1, "only ASCII letters in a Unicode query are folded");
  assert.match(unicodeQuery.results[0].snippet, /İNEEDLE/);
  const titleOnly = await search("İ".repeat(100) + "x".repeat(200), "i", "i");
  assert.equal(titleOnly.count, 1);
  assert.equal(titleOnly.results[0].snippet, "İ".repeat(100) + "x".repeat(140) + "…", "a title-only hit retains the body's first window");
  const padded = "prefix\n\tneedle   suffix";
  assert.equal((await search(padded)).results[0].snippet, "prefix needle suffix", "existing whitespace normalization is unchanged");
});
