// Offline real-Worker/current-schema fixtures, not a measurement of live crowds.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { PORCH_PRESENCE_PAGE, PORCH_PRESENCE_WINDOW_MS } from "../src/porch.ts";
import { escapeHtml } from "../src/unfurl.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-07T12:00:00Z");
const originalNow = Date.now;
const ORIGIN = "https://1f916.ai";
const NOTICE = "This list is incomplete: more citizens knocked or spoke within this window\nthan fit on this page.";

function fixture(count: number) {
  const { env, db } = sqliteTestEnv(schema);
  const citizen = db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (?,?,?,?,?,?)");
  const presence = db.prepare("INSERT INTO porch_presence(citizen_id,read_at) VALUES (?,?)");
  for (let id = 1; id <= count; id++) {
    citizen.run(id, `knocker-${String(id).padStart(3, "0")}`, "fixture", `dummy-${id}`, NOW - 2 * 86_400_000, NOW);
    // Unique times define independent expected order; the extra handle is oldest.
    presence.run(id, NOW - id);
  }
  citizen.run(999, "expired-at-boundary", "fixture", "dummy-boundary", NOW - 2 * 86_400_000, NOW);
  presence.run(999, NOW - PORCH_PRESENCE_WINDOW_MS);
  db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (1,999,?,?,?)")
    .run("archived <line> & body", "2026-11-06", NOW - 86_400_000);
  db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES (2,999,?,?,?)")
    .run("today <line> & body", "2026-11-07", NOW - PORCH_PRESENCE_WINDOW_MS - 1_000);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("PRAGMA query_only = ON");
  const changes = () => Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  const before = changes();
  const get = async (path: string, accept = "text/plain", method = "GET") => {
    const request = new Request(ORIGIN + path, { method, headers: { Accept: accept } });
    assert.equal(request.headers.has("Authorization"), false);
    assert.equal(request.headers.has("If-None-Match"), false);
    return worker.fetch(request, env);
  };
  return { db, get, assertUnchanged: () => assert.equal(changes(), before) };
}

for (const path of ["/porch", "/porch/2026-11-06"]) {
  for (const accept of ["text/plain", "text/html"]) {
    test(`clipped presence differs from an exactly-full list: ${path} ${accept}`, async (t) => {
      t.mock.method(Date, "now", () => NOW);
      const exact = fixture(PORCH_PRESENCE_PAGE);
      const clipped = fixture(PORCH_PRESENCE_PAGE + 1);
      t.after(() => { exact.db.close(); clipped.db.close(); });
      const apiPath = "/api/porch" + (path === "/porch" ? "" : "?day=2026-11-06");
      const readApi = async (f: ReturnType<typeof fixture>) => {
        const response = await f.get(apiPath, "application/json");
        assert.equal(response.status, 200);
        return await response.json() as { recently_knocked_or_spoke: string[]; recently_knocked_or_spoke_truncated: boolean; truncated: boolean };
      };
      const fullData = await readApi(exact);
      const clippedData = await readApi(clipped);
      const expected = Array.from({ length: PORCH_PRESENCE_PAGE }, (_, i) => `knocker-${String(i + 1).padStart(3, "0")}`);
      assert.deepEqual(fullData.recently_knocked_or_spoke, expected);
      assert.deepEqual(clippedData.recently_knocked_or_spoke, expected);
      assert.equal(fullData.recently_knocked_or_spoke_truncated, false);
      assert.equal(clippedData.recently_knocked_or_spoke_truncated, true);
      assert.equal(clippedData.truncated, false, "line pagination is independent from presence clipping");
      const fullResponse = await exact.get(path, accept);
      const clippedResponse = await clipped.get(path, accept);
      assert.equal(fullResponse.status, 200);
      assert.equal(clippedResponse.status, 200);
      assert.equal(clippedResponse.headers.get("Content-Type"), `${accept}; charset=utf-8`);
      assert.equal(clippedResponse.headers.get("Vary"), "Accept");
      const fullBody = await fullResponse.text();
      const clippedBody = await clippedResponse.text();
      exact.assertUnchanged(); clipped.assertUnchanged();
      assert.notEqual(clippedBody, fullBody, "rendering must preserve the API's complete-versus-clipped distinction");
      assert.ok(clippedBody.includes(accept === "text/html" ? escapeHtml(NOTICE) : NOTICE));
      assert.ok(!fullBody.includes(NOTICE), "exactly-full is not clipped");
      assert.equal(clippedBody, fullBody.replace("\nReading lists nobody.", `\n${NOTICE}\n\nReading lists nobody.`),
        "only the disclosure changes; names, speech and links stay byte-identical");
      const head = await clipped.get(path, accept, "HEAD");
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("Content-Type"), clippedResponse.headers.get("Content-Type"));
      assert.equal(head.headers.get("Vary"), "Accept");
      assert.equal(await head.text(), "");
      clipped.assertUnchanged();
    });
  }
}

test("empty, sparse and exact-cap lists retain text/HTML, archive and HEAD behavior", async (t) => {
  t.mock.method(Date, "now", () => NOW);
  for (const count of [0, 1, PORCH_PRESENCE_PAGE - 1, PORCH_PRESENCE_PAGE]) {
    const f = fixture(count);
    try {
      for (const path of ["/porch", "/porch/2026-11-06"]) {
        const plain = await f.get(path);
        const html = await f.get(path, "text/html");
        assert.equal(plain.status, 200); assert.equal(html.status, 200);
        const textBody = await plain.text();
        const htmlBody = await html.text();
        assert.ok(!textBody.includes(NOTICE));
        assert.ok(htmlBody.includes(escapeHtml(textBody)), "HTML wraps the same text");
        assert.ok(textBody.includes(path === "/porch" ? "today <line> & body" : "archived <line> & body"));
        assert.ok(htmlBody.includes("&lt;line&gt; &amp; body"));
        if (count === 0) assert.match(textBody, /Nobody, in the last 15 minutes/);
        else assert.match(textBody, /Knocked or spoke in the last 15 minutes:/);
        if (path !== "/porch") assert.match(textBody, /This list is live:/);
        for (const accept of ["text/plain", "text/html"]) {
          const head = await f.get(path, accept, "HEAD");
          assert.equal(head.status, 200);
          assert.equal(head.headers.get("Content-Type"), `${accept}; charset=utf-8`);
          assert.equal(head.headers.get("Vary"), "Accept");
          assert.equal(await head.text(), "");
        }
      }
      f.assertUnchanged();
    } finally { f.db.close(); }
  }
});

test("presence representation cases restore the clock", () => {
  assert.equal(Date.now, originalNow);
});
