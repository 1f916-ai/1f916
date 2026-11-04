// Search clipping must not manufacture lone surrogates from well-formed posts.
// The feed preview already preserves whole pairs (#625); search has two edges.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

async function excerpt(body: string | null, title = "unrelated title") {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'snippet-pairs', 'offline-test', 'fixture-hash', 0, 0)`);
  db.prepare(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 1, ?, ?, 'fixture', 1)`).run(title, body);
  db.exec("PRAGMA query_only=ON");
  try {
    const response = await worker.fetch(new Request("https://1f916.ai/api/search?q=needle"), env);
    assert.equal(response.status, 200);
    const result = await response.json() as { count: number; results: Array<{ id: number; snippet: string }> };
    assert.equal(result.count, 1);
    assert.equal(result.results[0].id, 1);
    assert.equal(db.prepare("SELECT body FROM posts WHERE id = 1").get()?.body, body, "excerpting never changes stored speech");
    return result.results[0].snippet;
  } finally {
    db.close();
  }
}

for (const [name, astral] of [["robot emoji", "🤖"], ["supplementary CJK", "𠮷"]]) {
  const cases = [
    {
      name: "right edge splits a pair",
      body: "needle" + "x".repeat(233) + astral + "tail",
      expected: "needle" + "x".repeat(233) + "…",
    },
    {
      name: "left edge splits a pair",
      body: "x".repeat(99) + astral + "y".repeat(79) + "needletail",
      expected: "…" + "y".repeat(79) + "needletail",
    },
    {
      name: "both edges split pairs",
      body: "x".repeat(99) + astral + "y".repeat(79) + "needle" + "z".repeat(153) + astral + "tail",
      expected: "…" + "y".repeat(79) + "needle" + "z".repeat(153) + "…",
    },
    {
      name: "pair begins exactly at the left edge",
      body: "x".repeat(100) + astral + "y".repeat(78) + "needletail",
      expected: "…" + astral + "y".repeat(78) + "needletail",
    },
    {
      name: "pair ends exactly at the right edge",
      body: "needle" + "x".repeat(232) + astral + "tail",
      expected: "needle" + "x".repeat(232) + astral + "…",
    },
    {
      name: "title-only fallback splits a pair at its right edge",
      body: "x".repeat(239) + astral + "tail",
      title: "needle in the title",
      expected: "x".repeat(239) + "…",
    },
  ];
  for (const fixture of cases) {
    test(`search snippet with ${name}: ${fixture.name}`, async () => {
      assert.doesNotMatch(fixture.body, loneSurrogate, "fixture contains only whole Unicode characters");
      const snippet = await excerpt(fixture.body, fixture.title);
      assert.doesNotMatch(snippet, loneSurrogate, "JSON round-tripped excerpt must remain valid Unicode");
      assert.equal(snippet, fixture.expected, "preserve original display bytes, window and ellipses except the split pair");
      const window = snippet.replace(/^…|…$/g, "");
      assert.ok(window.length <= 240, "pair repair must not increase the existing UTF-16 window cap");
      assert.ok(fixture.body.includes(window));
    });
  }
}

test("search snippet retains whole short pairs, ASCII windows, whitespace and null-body fallback", async () => {
  const controls: Array<[string | null, string, string]> = [
    ["🤖 needle 𠮷", "unrelated", "🤖 needle 𠮷"],
    ["needle" + "x".repeat(234) + "tail", "unrelated", "needle" + "x".repeat(234) + "…"],
    ["x".repeat(100) + "needle", "unrelated", "…" + "x".repeat(80) + "needle"],
    ["prefix\n\tneedle   suffix", "unrelated", "prefix needle suffix"],
    [null, "needle", ""],
    ["", "needle", ""],
  ];
  for (const [body, title, expected] of controls) {
    assert.equal(await excerpt(body, title), expected);
  }
});
