import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { PORCH_PAGE } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ORIGIN = "https://1f916.ai";
const DAY = "2026-10-07";
const NOW = Date.parse("2026-10-08T12:00:00Z");

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (1,?,?,?,?,?)")
    .run("citation-reader", "test", "dummy", NOW, NOW);
  const insert = db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (?,1,?,?,?)");
  for (let id = 1; id <= 405; id++) insert.run(id, `LINE-${id}-UNIQUE`, DAY, NOW - 86_400_000);
  insert.run(700, "OTHER-DAY-UNIQUE", "2026-10-06", NOW - 2 * 86_400_000);
  insert.run(900, "TODAY-UNIQUE", "2026-10-08", NOW);
  db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES (1,1,?,?,?,?)")
    .run("Carried lines", "porch:1 porch:200 porch:201 porch:401 porch:405 porch:900 porch:999", "fixture", NOW);
  const get = (path: string, accept = "text/plain") => {
    const url = new URL(path, ORIGIN);
    // Browsers do not send the fragment. Resolution must not depend on it.
    url.hash = "";
    return worker.fetch(new Request(url, { headers: { Accept: accept } }), env);
  };
  return { db, get };
}

function renderedIds(body: string): number[] {
  return [...body.matchAll(/LINE-(\d+)-UNIQUE/g)].map((match) => Number(match[1]));
}

test("every supplied porch citation URL serves its surviving target across archive pages", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { db, get } = fixture();
  t.after(() => db.close());
  const response = await get("/api/post/1", "application/json");
  assert.equal(response.status, 200);
  const post = await response.json() as { porch_cited: { line_id: number; read: string }[] };
  assert.deepEqual(post.porch_cited.map((line) => line.line_id), [1, 200, 201, 401, 405, 900]);
  for (const line of post.porch_cited) {
    for (const accept of ["text/plain", "text/html"]) {
      const page = await get(line.read, accept);
      assert.equal(page.status, 200);
      assert.match(page.headers.get("Content-Type") ?? "", new RegExp(accept));
      const body = await page.text();
      const ids = renderedIds(body);
      assert.ok(body.includes(line.line_id === 900 ? "TODAY-UNIQUE" : `LINE-${line.line_id}-UNIQUE`),
        `supplied read omitted cited line ${line.line_id} (${accept})`);
      assert.ok(ids.length <= PORCH_PAGE, "a citation cannot unbound the archive page");
      assert.ok(!body.includes("OTHER-DAY-UNIQUE"));
      if (line.line_id !== 900) assert.ok(!body.includes("TODAY-UNIQUE"));
      if (accept === "text/html") {
        const canonical = new URL(line.read, ORIGIN);
        canonical.hash = "";
        assert.equal(body.match(/<link rel="canonical" href="([^"]+)">/)?.[1], canonical.href,
          "the unfurl must retain the dated target page cursor");
      }
    }
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM porch_presence").get() as { n: number }).n, 0);
});

test("prose cursors share API bounds, sparse ids, exhaustion and validation without claiming an empty day", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  const { db, get } = fixture();
  t.after(() => db.close());
  db.prepare("DELETE FROM porch_lines WHERE id = 400").run();
  db.prepare("INSERT INTO porch_compactions(day,lines,compacted_at) VALUES (?,1,?)").run(DAY, NOW);
  for (const since of ["0", "000", "200", "000200", "400", "405"]) {
    const api = await get(`/api/porch?day=${DAY}&since=${since}`, "application/json");
    assert.equal(api.status, 200);
    const data = await api.json() as { lines: { id: number }[]; truncated: boolean };
    const page = await get(`/porch/${DAY}?since=${since}`);
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.deepEqual(renderedIds(body), data.lines.map((line) => line.id));
    if (Number(since) > 0) assert.ok(!body.includes("the first 200 lines of the day"));
    if (!data.lines.length) {
      assert.ok(!body.includes("Nobody has said anything") && !body.includes("Nothing from this day is still here"));
      assert.match(body, /after line 405/);
      assert.match(body, /1 line from this day was not cited within thirty days and was compacted on 2026-10-08/,
        "an exhausted cursor must still disclose the day's compaction receipt");
    }
  }
  const today = await get("/porch?since=700");
  assert.equal(today.status, 200);
  assert.ok((await today.text()).includes("TODAY-UNIQUE"));
  for (const route of ["/porch", `/porch/${DAY}`]) {
    for (const since of ["-1", "not-a-line", "1000"]) {
      const result = await get(`${route}?since=${since}`);
      assert.equal(result.status, 400);
      assert.match((await result.json() as { error: string }).error, /since/);
    }
    assert.equal((await get(`${route}?unknown=1`)).status, 400);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM porch_presence").get() as { n: number }).n, 0);
});
