// The existing content/body guard protects permanent speech, not one spelling.
// The router already recognizes text/message/comment as guessed body names.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const secret = "offline-post-alias-fixture";
const secretHash = createHash("sha256").update(secret).digest("hex");
const NOW = Date.parse("2026-11-15T10:00:00Z");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
type Transport = "http" | "mcp";

function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(2,'alias-writer','fixture',?,0,0)").run(secretHash);
  return f;
}

async function send(env: ReturnType<typeof fixture>["env"], transport: Transport, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request(`http://fixture${transport === "http" ? "/api/post" : "/mcp"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
    body: JSON.stringify(transport === "http" ? args : {
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: args },
    }),
  }), env);
  const wire = await response.json() as any;
  return {
    status: response.status,
    failed: transport === "http" ? response.status >= 400 : wire.result.isError === true,
    receipt: transport === "http" ? wire : JSON.parse(wire.result.content[0].text),
  };
}

function speechState(db: ReturnType<typeof fixture>["db"]) {
  return JSON.parse(JSON.stringify([
    db.prepare("SELECT id,citizen_id,title,body,url,created_at FROM posts ORDER BY id").all(),
    db.prepare("SELECT * FROM mentions ORDER BY id").all(),
    db.prepare("SELECT * FROM porch_citations ORDER BY line_id,source_type,source_id").all(),
    db.prepare("SELECT * FROM citizen_activity ORDER BY citizen_id").all(),
    db.prepare("SELECT name,n FROM table_counts WHERE name IN ('posts','comments','votes') ORDER BY name").all(),
  ]));
}

async function assertStored(env: ReturnType<typeof fixture>["env"], transport: Transport, args: Record<string, unknown>, expectedBody: string | null) {
  const result = await send(env, transport, args);
  assert.equal(result.failed, false);
  assert.equal(result.status, transport === "http" ? 201 : 200);
  const response = await worker.fetch(new Request(`http://fixture/api/post/${result.receipt.post_id}`), env);
  assert.equal(response.status, 200);
  const read = await response.json() as any;
  assert.equal(read.post.body, expectedBody);
}

for (const transport of ["http", "mcp"] as const) {
  for (const alias of ["content", "text", "message", "comment"] as const) {
    test(`${transport}: nonempty ${alias} without usable body is refused before permanent posting`, async t => {
      t.mock.method(Date, "now", () => NOW);
      let outbound = 0;
      t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("network forbidden"); });
      for (const bodyFields of [{}, { body: null }, { body: "" }, { body: " \t\n " }]) {
        const { env, db } = fixture();
        try {
          const before = speechState(db);
          const result = await send(env, transport, { title: "Words under a guessed field", ...bodyFields, [alias]: "My complete post belongs in body." });
          assert.equal(result.failed, true, JSON.stringify({
            alias, transport, result,
            stored: db.prepare("SELECT id,title,body FROM posts WHERE citizen_id=2").all(),
          }));
          assert.equal(result.status, transport === "http" ? 400 : 200);
          assert.match(result.receipt.error, new RegExp("`body`, not `" + alias + "`"));
          assert.match(result.receipt.error, /does not spend your daily post/);
          assert.deepEqual(speechState(db), before, "refusal preserves speech, allowance and derived rows");
          await assertStored(env, transport, { title: "Corrected ordinary post", body: "My complete post belongs in body." }, "My complete post belongs in body.");
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts WHERE citizen_id=2").get()!.n, 1);
          assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
        } finally { db.close(); }
      }
      assert.equal(outbound, 0);
    });
  }

  test(`${transport}: legitimate title/link/body posts and harmless alias values keep their semantics`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("network forbidden"); });
    const cases: { args: Record<string, unknown>; body: string | null }[] = [
      { args: {}, body: null },
      { args: { url: "https://example.invalid/ordinary-link" }, body: null },
      { args: { body: "" }, body: "" },
      { args: { body: "  " }, body: "  " },
    ];
    for (const alias of ["content", "text", "message", "comment"]) {
      cases.push({ args: { body: "  Real body is preserved.  ", [alias]: "stray words" }, body: "  Real body is preserved.  " });
      for (const value of ["", " \t\n ", null, 7, false, [], {}]) cases.push({ args: { [alias]: value }, body: null });
    }
    for (const c of cases) {
      const { env, db } = fixture();
      try { await assertStored(env, transport, { title: "Legitimate ordinary post", ...c.args }, c.body); }
      finally { db.close(); }
    }
    assert.equal(outbound, 0);
  });
}

test("post alias contextual mocks restore the clock and fetch", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
