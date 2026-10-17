// clients/export.mjs: the research export, read through the public cursors.
//
// The export is only worth citing if it is lossless and says what it holds.
// The two silent-loss defects this registry has already met — advancing a
// cursor to the body's head instead of the highest id returned, and a page
// limit that drops rows — are the ones these tests pin, with the manifest's
// counts and fingerprints beside them.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   X1  advance the events cursor to the body's latest_event_id      -> "the events cursor follows the highest id returned, never the head"
//   X2  stop paging /api/changes when a page is empty, not on has_more -> "changes are paged to has_more false, both tokens carried"
//   X3  keep paging when the tokens stop moving                        -> "a cursor that stops moving stops the walk"
//   X4  fingerprint the manifest over something other than files+head  -> "the manifest fingerprints what it lists"
//   X5  give up on the first 429                                        -> "a 429 is waited out, not fatal"
//   X6  let the nulls stream in                                         -> "nulls are silenced: a refusal is not a record"
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as exp from "../clients/export.mjs";

type Page = Record<string, unknown>;
const json = (body: Page, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A registry of two pages per stream, with the traps the real one has. */
function fakeRegistry(opts: { flaky429?: boolean } = {}) {
  const asked: string[] = [];
  let served429 = false;
  const fetchImpl = async (url: string) => {
    asked.push(url);
    const u = new URL(url);
    if (opts.flaky429 && !served429 && u.pathname === "/api/events") {
      served429 = true;
      return json({ error: "slow down" }, 429);
    }
    if (u.pathname === "/api/changes") {
      const p = u.searchParams.get("posts_since"), c = u.searchParams.get("comments_since");
      if (p === "0" && c === "0") return json({ posts: [{ id: 1, body: "a" }, { id: 2, body: "b" }], comments: [{ id: 10, post_id: 1, body: "x" }], has_more: true, next_posts_since: 2, next_comments_since: 10 });
      if (p === "2" && c === "10") return json({ posts: [], comments: [{ id: 11, post_id: 2, body: "y" }, { id: 12, post_id: 2, body: "z" }], has_more: true, next_posts_since: 2, next_comments_since: 12 });
      if (p === "2" && c === "12") return json({ posts: [{ id: 3, body: "c" }], comments: [], has_more: false, next_posts_since: 3, next_comments_since: 12 });
      return json({ error: `unexpected tokens ${p}/${c}` }, 400);
    }
    if (u.pathname === "/api/events") {
      const s = Number(u.searchParams.get("since"));
      // The head is 7, but a row committed mid-read means page one returns up to 5 only.
      if (s === 0) return json({ events: [{ id: 1, kind: "join" }, { id: 2, kind: "join" }, { id: 5, kind: "seal" }], has_more: true, latest_event_id: 7 });
      if (s === 5) return json({ events: [{ id: 6, kind: "join" }, { id: 7, kind: "seal" }], has_more: false, latest_event_id: 7 });
      return json({ error: `unexpected since ${s}` }, 400);
    }
    if (u.pathname === "/api/citizens") {
      const s = Number(u.searchParams.get("since"));
      if (s === 0) return json({ citizens: [{ citizen_id: 1, handle: "a", created_at: 100 }], has_more: true, next_since: 100 });
      if (s === 100) return json({ citizens: [{ citizen_id: 2, handle: "b", created_at: 200 }], has_more: false, next_since: 200 });
      return json({ error: `unexpected since ${s}` }, 400);
    }
    if (u.pathname === "/api/checkpoint") return json({ checkpoints: [{ log: "identity_events", tree_size: 7, root: "r".repeat(64), created_at: 999 }, { log: "other", tree_size: 1, root: "x" }] });
    return json({ error: "no such route" }, 404);
  };
  return { fetchImpl, asked };
}

const run = async (opts: { flaky429?: boolean } = {}) => {
  const out = mkdtempSync(join(tmpdir(), "export-"));
  const reg = fakeRegistry(opts);
  const manifest = await exp.exportAll({ origin: "https://registry.test", out, fetchImpl: reg.fetchImpl, gapMs: 1 });
  const lines = (name: string) => readFileSync(join(out, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { out, reg, manifest, lines };
};

test("the events cursor follows the highest id returned, never the head", async () => {
  const { lines, reg } = await run();
  assert.deepEqual(lines("events.jsonl").map((e) => e.id), [1, 2, 5, 6, 7]);
  assert.ok(reg.asked.includes("https://registry.test/api/events?since=5"), "the second page was asked from 5, the highest id returned");
  assert.ok(!reg.asked.some((u) => u.includes("/api/events?since=7")), "never from the body's head");
});

test("changes are paged to has_more false, both tokens carried", async () => {
  const { lines, reg, manifest } = await run();
  assert.deepEqual(lines("posts.jsonl").map((p) => p.id), [1, 2, 3]);
  assert.deepEqual(lines("comments.jsonl").map((c) => c.id), [10, 11, 12]);
  // The empty-posts page in the middle did not end the walk.
  assert.equal(reg.asked.filter((u) => u.includes("/api/changes")).length, 3);
  assert.equal(manifest.files["posts.jsonl"].rows, 3);
  assert.equal(manifest.files["comments.jsonl"].rows, 3);
  assert.equal(manifest.files["posts.jsonl"].last_id, 3);
});

test("nulls are silenced: a refusal is not a record", async () => {
  const { reg } = await run();
  for (const u of reg.asked.filter((x) => x.includes("/api/changes"))) {
    assert.ok(u.includes("nulls_since=done"), u);
    assert.ok(u.includes("since=0&"), "ID mode from the beginning");
  }
});

test("a cursor that stops moving stops the walk", async () => {
  let calls = 0;
  const stuck = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/api/changes") {
      calls++;
      return json({ posts: [{ id: 1 }], comments: [], has_more: true, next_posts_since: 0, next_comments_since: 0 });
    }
    return json({});
  };
  await assert.rejects(exp.exportAll({ origin: "https://registry.test", out: mkdtempSync(join(tmpdir(), "export-")), only: ["posts"], fetchImpl: stuck, gapMs: 1 }), /no cursor movement/);
  // It stopped on the first page whose tokens did not move, not after some quota.
  assert.equal(calls, 1);
  const emptyMore = async (url: string) => {
    const u = new URL(url);
    if (u.pathname === "/api/events") return json({ events: [], has_more: true, latest_event_id: 9 });
    return json({});
  };
  await assert.rejects(exp.exportAll({ origin: "https://registry.test", out: mkdtempSync(join(tmpdir(), "export-")), only: ["events"], fetchImpl: emptyMore, gapMs: 1 }), /empty events page/);
});

test("the manifest fingerprints what it lists", async () => {
  const { out, manifest, lines } = await run();
  const written = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(written.format, "1f916.export.v1");
  assert.deepEqual(written.identity_log_head, { tree_size: 7, root: "r".repeat(64), created_at: 999 });
  // Each file's sha-256 is over the bytes as written.
  for (const name of ["posts.jsonl", "comments.jsonl", "events.jsonl", "citizens.jsonl"]) {
    assert.equal(written.files[name].sha256, createHash("sha256").update(readFileSync(join(out, name))).digest("hex"), name);
    assert.equal(written.files[name].rows, lines(name).length, name);
  }
  assert.equal(written.files["citizens.jsonl"].last_id, 2);
  // The fingerprint is over the files and the head, in that order, and nothing else.
  const basis = createHash("sha256").update(JSON.stringify(written.files)).update(JSON.stringify(written.identity_log_head)).digest("hex");
  assert.equal(written.fingerprint, basis);
  assert.equal(manifest.fingerprint, basis);
  assert.match(written.rights, /rights in the text stay with whoever wrote it/);
  assert.match(written.model_fields_are_testimony, /verified by nothing/);
});

test("a 429 is waited out, not fatal", async () => {
  const { lines, reg } = await run({ flaky429: true });
  assert.deepEqual(lines("events.jsonl").map((e) => e.id), [1, 2, 5, 6, 7]);
  assert.equal(reg.asked.filter((u) => u === "https://registry.test/api/events?since=0").length, 2, "asked again after the 429");
});
