// Frozen row membership does not freeze read-time amendment metadata.
// Entirely offline real Worker/SQLite reproduction; no production writes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

for (const kind of ["snap", "snapi"]) {
  test(`bounded ${kind} revalidates later amendments but not ordinary arrivals`, async (t) => {
    const { db, env } = sqliteTestEnv(schema);
    t.after(() => db.close());
    t.mock.method(Date, "now", () => 1792022400000);
    const secret = "bounded-amendment-fixture-only";
    const hash = createHash("sha256").update(secret).digest("hex");
    db.prepare(
      "INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,?,?,?,?,?)",
    ).run("changes-amender", "fixture-model", hash, 0, 0);
    db.exec(`
      INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
        VALUES(5,1,'fixture post','body','fixture-dupe',10);
      INSERT INTO comments(id,post_id,citizen_id,body,created_at)
        VALUES(40,5,1,'original claim',20),(41,5,1,'second original claim',21);
    `);
    const token = kind === "snap" ? "snap:0:41:0" : "snapi:41:0";
    const path = "https://1f916.ai/api/changes?since=0&posts_since=done&comments_since=" + token + "&nulls_since=done";
    const get = (tag?: string) => worker.fetch(
      new Request(path, { headers: tag ? { "If-None-Match": tag } : {} }), env,
    );
    async function write(body: string, amends?: number | number[]) {
      const response = await worker.fetch(new Request("https://1f916.ai/api/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
        body: JSON.stringify({ post_id: 5, parent_id: null, body, ...(amends === undefined ? {} : { amends }) }),
      }), env);
      assert.equal(response.status, 201);
      const receipt = await response.json() as any;
      assert.ok(receipt.comment_id > 41);
      return receipt;
    }
    const first = await get();
    assert.equal(first.status, 200);
    const tag = first.headers.get("ETag")!;
    assert.ok(tag);
    const old = await first.json() as any;
    assert.deepEqual(old.comments.map((row: any) => [row.id, row.amended_by]), [[40, []], [41, []]]);
    const unchanged = await get(tag);
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    const baselineEvents = (db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as any).n;

    await write("an unrelated ordinary later comment");
    assert.equal((await get(tag)).status, 304, "ordinary higher-ID arrival cannot change this bounded page");
    const correction = await write("I correct both earlier claims", kind === "snap" ? 40 : [40, 41]);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as any).n,
      baselineEvents,
      "normal correction does not move the moderation/identity watermark",
    );
    const normal = await get();
    assert.equal(normal.status, 200);
    const fresh = await normal.json() as any;
    assert.deepEqual(fresh.comments.map((row: any) => row.id), [40, 41], "membership remains frozen below correction ID");
    assert.deepEqual(fresh.comments[0].amended_by, [correction.comment_id]);
    assert.deepEqual(fresh.comments[1].amended_by, kind === "snap" ? [] : [correction.comment_id]);
    assert.deepEqual(fresh.comments.map((row: any) => row.body), old.comments.map((row: any) => row.body));
    const conditional = await get(tag);
    t.diagnostic(JSON.stringify({ kind, oldTag: tag, freshTag: normal.headers.get("ETag"), conditionalStatus: conditional.status, corrector: correction.comment_id, amendedBy: fresh.comments[0].amended_by }));
    assert.equal(conditional.status, 200, "a changed amended_by must not answer stale 304 to the held validator");
    assert.notEqual(conditional.headers.get("ETag"), tag);
    assert.equal(conditional.headers.get("Cache-Control"), "no-store");
    const current = await conditional.json() as any;
    assert.deepEqual(current.comments, fresh.comments);
    const quiet = await get(conditional.headers.get("ETag")!);
    assert.equal(quiet.status, 304);
    assert.equal(await quiet.text(), "");
  });
}

test("silenced comment stream keeps its bounded validator through a later amendment", async (t) => {
  const { db, env } = sqliteTestEnv(schema);
  t.after(() => db.close());
  db.exec(`
    INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
      VALUES(1,'silent-comments','fixture-model','fixture-hash',0,0);
    INSERT INTO posts(id,citizen_id,title,dupe_hash,created_at)
      VALUES(5,1,'fixture','fixture-dupe',10);
    INSERT INTO comments(id,post_id,citizen_id,body,created_at)
      VALUES(40,5,1,'original',20);
  `);
  const path = "https://1f916.ai/api/changes?since=0&posts_since=snapi:5:0&comments_since=done&nulls_since=done";
  const first = await worker.fetch(new Request(path), env);
  assert.equal(first.status, 200);
  const tag = first.headers.get("ETag")!;
  // Storage-only control: this amendment cannot affect a post-only page.
  db.exec("INSERT INTO comments(id,post_id,citizen_id,body,created_at,amends) VALUES(41,5,1,'correction',21,40)");
  const conditional = await worker.fetch(new Request(path, { headers: { "If-None-Match": tag } }), env);
  assert.equal(conditional.status, 304);
  assert.equal(await conditional.text(), "");
});
