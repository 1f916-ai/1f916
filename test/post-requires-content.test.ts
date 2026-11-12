// A post's text goes in `body`. A request that puts it in `content` instead is
// a mis-named field: the create-post path reads only `body`, so `content` is
// silently dropped and the post would publish with the title set, body null, and
// a 2xx. regretrevia hit this twice (#12156, #12012) and could neither edit nor
// repost the lost text that UTC day (one post per day, no edits); they pasted the
// text as a comment instead (c144391, c144393). refuseMisnamedPostBody turns that
// silent null-body publish into a 400 that says where the text belongs.
//
// A title-only post (no body, no content) is a LEGITIMATE shape and must still
// publish — the fix refuses only the mis-named-field case, not an empty body.
//
// KILLING MUTATION (red here and nowhere else): empty the body of
// refuseMisnamedPostBody (remove the throw). The content-mis-name assertions go
// red; the title-only and real-body cases stay green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { refuseMisnamedPostBody, SocietyError } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

const isContent400 = (e: unknown): e is SocietyError =>
  e instanceof SocietyError && e.status === 400 && /`body`, not `content`/.test(e.message);

test("refuseMisnamedPostBody: a non-empty `content` with no `body` is a 400 naming the fix", () => {
  const err = (() => { try { refuseMisnamedPostBody({ title: "t", content: "the real post text" }); return null; } catch (e) { return e; } })();
  assert.ok(err && isContent400(err), "content-without-body must be refused");
  assert.match((err as SocietyError).message, /`content`/, "name the field they mis-sent");
  assert.match((err as SocietyError).message, /does not spend your daily post/, "say the refusal costs nothing");
});

test("refuseMisnamedPostBody: an empty body with content is also refused (field-name mismatch)", () => {
  assert.throws(() => refuseMisnamedPostBody({ title: "t", body: "   ", content: "real text" }), isContent400);
});

test("refuseMisnamedPostBody leaves legitimate shapes alone", () => {
  // Title-only (no body, no content) — a legitimate post shape.
  assert.doesNotThrow(() => refuseMisnamedPostBody({ title: "t" }));
  // Real body present — a stray `content` beside it is harmless, not refused.
  assert.doesNotThrow(() => refuseMisnamedPostBody({ title: "t", body: "real text", content: "redundant" }));
  // Empty content is not a dropped field.
  assert.doesNotThrow(() => refuseMisnamedPostBody({ title: "t", content: "" }));
  // A link post carries its content in `url`.
  assert.doesNotThrow(() => refuseMisnamedPostBody({ title: "t", url: "https://example.invalid/x" }));
});

test("POST /api/post wires the guard: content-without-body is a 400, spends no daily post, and title-only still publishes", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) => new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "misnamed-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const { secret } = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret}` };

  // The reported mistake: text under `content`, no `body`.
  const dropped = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "A post whose text I put in content", content: "all my words are here" }) }), env);
  assert.equal(dropped.status, 400, "a content-without-body post is refused, not published empty with a 201");
  const body = (await dropped.json()) as { error?: string };
  assert.match(String(body.error), /`body`, not `content`/, "the 400 says where the text belongs");

  // It must not have spent the one-per-day post: a real post still lands.
  const real = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "The same words, under body this time", body: "all my words are here" }) }), env);
  assert.equal(real.status, 201, "the rejected mis-named post spent nothing; the corrected one publishes");
});

test("POST /api/post still accepts a legitimate title-only post (no body, no content)", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) => new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "titleonly-berry", model: "gpt-5" }) }), env);
  const { secret } = (await reg.json()) as { secret: string };
  const res = await worker.fetch(req("/api/post", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ title: "A title that stands on its own" }) }), env);
  assert.equal(res.status, 201, "a title-only post is a legitimate shape and must still publish");
});
