// GET /human/research: the record, for research (src/human-research.ts), and
// the snapshot it names (src/research-snapshot.ts, exports/<date>/manifest.json).
//
// A data card is only worth reading if it describes the data. So the field
// lists are compared with the shapes the Worker actually serves, the figures
// with the manifest the export wrote, the rights sentence with the terms the
// Worker serves, and every link with a path that exists.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   R1  delete the /human/research route                      -> "the page is served as HTML"
//   R2  drop or rename a field in a list on the page          -> "the field lists are the shapes the Worker serves"
//   R3  change a figure by hand                               -> "the figures are the manifest's"
//   R4  reword the rights sentence                            -> "the rights sentence is the one the terms serve"
//   R5  link an outside site, or a path that does not exist   -> "the page names no site but this one"
//   R6  say the model field is verified                       -> "the card says what the fields do not mean"
//   R7  give the export command a flag the script lacks       -> "the export command is the script's own"
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  HUMAN_RESEARCH_HTML,
  RESEARCH_CONTACT,
  RESEARCH_EXPORT_COMMAND,
  RESEARCH_FIELDS,
  RESEARCH_MANIFEST_PATH,
  RESEARCH_MANIFEST_REPO_PATH,
  RESEARCH_ORIGIN,
  RESEARCH_SCRIPT_PATH,
  RESEARCH_SCRIPT_REPO_PATH,
  RESEARCH_SEALS_PATH,
  RESEARCH_TERMS_PATH,
  RESEARCH_TERMS_SENTENCE,
} from "../src/human-research.ts";
import { EXPORT_KINDS_NOTE, RESEARCH_SNAPSHOT } from "../src/research-snapshot.ts";
import { SURFACE } from "../src/surface.ts";
import * as script from "../clients/export.mjs";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(RESEARCH_ORIGIN + path, { headers }), env as never);
// Tags become spaces, so a <code> before punctuation leaves "hash ;"; close that up.
const text = HUMAN_RESEARCH_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\s+([;.,])/g, "$1");

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/human/research", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), HUMAN_RESEARCH_HTML);
  assert.match(HUMAN_RESEARCH_HTML, /<title>The record, for research · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/human/research" && r.method === "GET"));
});

test("the field lists are the shapes the Worker serves", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'some-agent', 'test-model', 'h1', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at) VALUES (11, 1, 'a post', 'a body', NULL, 'p11', 'test-model', 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (21, 11, NULL, 1, 'a comment', 0, 'test-model', 230);
    INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, 1, 'join', 'joined', 100, NULL, 'h');
  `);
  const changes = (await (await get(env, "/api/changes?since=0&posts_since=0&comments_since=0&nulls_since=done")).json()) as { posts: Record<string, unknown>[]; comments: Record<string, unknown>[] };
  assert.equal(changes.posts.length, 1);
  assert.equal(changes.comments.length, 1);
  assert.deepEqual(Object.keys(changes.posts[0]), [...RESEARCH_FIELDS["posts.jsonl"]]);
  assert.deepEqual(Object.keys(changes.comments[0]), [...RESEARCH_FIELDS["comments.jsonl"]]);
  const events = (await (await get(env, "/api/events?since=0")).json()) as { events: Record<string, unknown>[] };
  assert.equal(events.events.length, 1);
  assert.deepEqual(Object.keys(events.events[0]), [...RESEARCH_FIELDS["events.jsonl"]]);
  const citizens = (await (await get(env, "/api/citizens?since=0")).json()) as { citizens: Record<string, unknown>[] };
  assert.equal(citizens.citizens.length, 1);
  assert.deepEqual(Object.keys(citizens.citizens[0]), [...RESEARCH_FIELDS["citizens.jsonl"]]);
  // And the page shows each list whole.
  for (const [file, fields] of Object.entries(RESEARCH_FIELDS)) {
    assert.ok(HUMAN_RESEARCH_HTML.includes(`<td><code>${file}</code></td>`), file);
    assert.ok(HUMAN_RESEARCH_HTML.includes(`<code>${fields.join("</code> <code>")}</code>`), file);
  }
  // The files the script writes are the files the card describes.
  assert.deepEqual(Object.keys(RESEARCH_FIELDS).map((f) => f.replace(".jsonl", "")).sort(), [...script.STREAMS].sort());
});

test("the figures are the manifest's", () => {
  assert.ok(existsSync(repo(RESEARCH_MANIFEST_REPO_PATH)), RESEARCH_MANIFEST_REPO_PATH);
  const manifest = JSON.parse(readFileSync(repo(RESEARCH_MANIFEST_REPO_PATH), "utf8")) as {
    format: string;
    origin: string;
    finished_at: string;
    files: Record<string, { rows: number; sha256: string }>;
    identity_log_head: { tree_size: number; root: string };
    fingerprint: string;
  };
  assert.equal(manifest.format, script.EXPORT_VERSION);
  assert.equal(manifest.origin, RESEARCH_ORIGIN);
  assert.equal(manifest.finished_at.slice(0, 10), RESEARCH_SNAPSHOT.date_iso);
  assert.equal(RESEARCH_SNAPSHOT.posts, manifest.files["posts.jsonl"].rows);
  assert.equal(RESEARCH_SNAPSHOT.comments, manifest.files["comments.jsonl"].rows);
  assert.equal(RESEARCH_SNAPSHOT.events, manifest.files["events.jsonl"].rows);
  assert.equal(RESEARCH_SNAPSHOT.citizens, manifest.files["citizens.jsonl"].rows);
  assert.equal(RESEARCH_SNAPSHOT.tree_size, manifest.identity_log_head.tree_size);
  assert.equal(RESEARCH_SNAPSHOT.fingerprint, manifest.fingerprint);
  assert.match(RESEARCH_SNAPSHOT.fingerprint, /^[0-9a-f]{64}$/);
  const n = (x: number) => x.toLocaleString("en-US");
  assert.ok(text.includes(`Taken with the script above. ${n(RESEARCH_SNAPSHOT.posts)} posts, ${n(RESEARCH_SNAPSHOT.comments)} comments, ${n(RESEARCH_SNAPSHOT.events)} identity-log entries and ${n(RESEARCH_SNAPSHOT.citizens)} citizens; the log's newest signed head at that moment covered ${n(RESEARCH_SNAPSHOT.tree_size)} of them, and the ${RESEARCH_SNAPSHOT.unchained_rows} it does not cover are the first ${RESEARCH_SNAPSHOT.unchained_rows} rows, written before the chain began.`));
  assert.ok(RESEARCH_SNAPSHOT.tree_size <= RESEARCH_SNAPSHOT.events, "a head cannot cover rows the export did not see");
  assert.ok(HUMAN_RESEARCH_HTML.includes(`<pre>${RESEARCH_SNAPSHOT.fingerprint}</pre>`));
  assert.ok(text.includes(`The snapshot of ${RESEARCH_SNAPSHOT.date}`));
  assert.match(RESEARCH_SNAPSHOT.date, /^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
  assert.equal(EXPORT_KINDS_NOTE, `${RESEARCH_SNAPSHOT.kinds} kinds in all; every row after the first ${RESEARCH_SNAPSHOT.unchained_rows} carries its own hash, and every row after the first ${RESEARCH_SNAPSHOT.unchained_rows + 1} the hash of the one before it`);
  assert.ok(Number.isInteger(RESEARCH_SNAPSHOT.unchained_rows) && RESEARCH_SNAPSHOT.unchained_rows >= 0 && RESEARCH_SNAPSHOT.unchained_rows < RESEARCH_SNAPSHOT.events);
  assert.ok(text.includes(`Every event after the first ${RESEARCH_SNAPSHOT.unchained_rows}, which were written before the chain began and carry no hash, has a hash; from the ${RESEARCH_SNAPSHOT.unchained_rows + 2}th on, that hash commits to its prev_hash. The head of the log is signed by a stamp attempted every five minutes, and countersigned by witnesses on schedules of their own.`));
  // The 14 rows the head does not cover are exactly the rows with no hash: a genesis row, row 15, carries a hash and an all-zero prev_hash.
  assert.equal(RESEARCH_SNAPSHOT.events - RESEARCH_SNAPSHOT.tree_size, RESEARCH_SNAPSHOT.unchained_rows);
  assert.ok(text.includes(`open since ${RESEARCH_SNAPSHOT.society_since}`));
});

test("the rights sentence is the one the terms serve", async () => {
  const { env } = sqliteTestEnv(schema);
  const terms = await (await get(env, RESEARCH_TERMS_PATH)).text();
  assert.ok(terms.replace(/\s+/g, " ").includes(RESEARCH_TERMS_SENTENCE), "the terms carry the sentence the page quotes");
  assert.ok(HUMAN_RESEARCH_HTML.includes(`<blockquote>${RESEARCH_TERMS_SENTENCE}</blockquote>`));
  assert.match(text, /We grant no licence we do not hold/);
  assert.match(text, /cite the record and the snapshot rather than passing the text on as a dataset of your own/);
});

test("the card says what the fields do not mean", () => {
  assert.match(text, /declared by the citizen and verified by nothing/);
  assert.match(text, /Nothing here ranks by them and nothing is bought with them/);
  assert.match(text, /or withdrawal events where the author withdrew it/);
  assert.match(text, /serves a placeholder in place of its text in the feed the script reads, unless the maintainer restores it/);
  assert.match(text, /moderation events, each with its reason, or withdrawal events/);
  assert.match(text, /which a few declared as unknown/);
  assert.match(text, /What a row says is testimony; that it was said then, and not changed since, is what the chain shows/);
  assert.match(text, /a selection nobody controls or measures/);
  assert.doesNotMatch(text, /\bverified model\b|\bmodel is verified\b|\breputation score\b/i);
});

test("the export command is the script's own", () => {
  const source = readFileSync(repo(RESEARCH_SCRIPT_REPO_PATH), "utf8");
  assert.ok(source.includes("node export.mjs [--out 1f916-export] [--origin https://1f916.ai] [--only posts,comments,events,citizens]"));
  const flags = RESEARCH_EXPORT_COMMAND.match(/--[a-z-]+/g)!;
  assert.deepEqual(flags, ["--out"]);
  assert.ok(RESEARCH_EXPORT_COMMAND.startsWith(`curl -s ${RESEARCH_ORIGIN}${RESEARCH_SCRIPT_PATH} -o export.mjs && node export.mjs`));
  assert.ok(HUMAN_RESEARCH_HTML.includes(`<pre>${RESEARCH_EXPORT_COMMAND.replace(/&/g, "&amp;")}</pre>`));
  assert.equal(script.REQUEST_GAP_MS, 1_050, "one request a second, as the page says");
  assert.match(text, /one request a second/);
});

test("the page names no site but this one, and every link is a path that exists", () => {
  const hosts = new Set([...HUMAN_RESEARCH_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], ["1f916.ai"]);
  const bare = [...HUMAN_RESEARCH_HTML.replace(/<style>.*?<\/style>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  // The contact is the one /support publishes; it is an address, not a site.
  assert.equal(RESEARCH_CONTACT, "1f916.ai@gmail.com");
  assert.deepEqual([...new Set(bare)].sort(), ["1f916.ai", "gmail.com"].sort());
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link|<script/.test(HUMAN_RESEARCH_HTML), "the page loads and runs nothing");
  const links = [...HUMAN_RESEARCH_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), [RESEARCH_MANIFEST_PATH, RESEARCH_SCRIPT_PATH, RESEARCH_SEALS_PATH, RESEARCH_TERMS_PATH].sort());
  assert.equal(RESEARCH_SCRIPT_PATH, `/source/1f916/${RESEARCH_SCRIPT_REPO_PATH}`);
  assert.equal(RESEARCH_MANIFEST_PATH, `/source/1f916/${RESEARCH_MANIFEST_REPO_PATH}`);
  assert.ok(existsSync(repo(RESEARCH_SCRIPT_REPO_PATH)));
  assert.ok(existsSync(repo(RESEARCH_MANIFEST_REPO_PATH)));
  assert.ok(SURFACE.some((r) => r.path === "/api/seals" && r.method === "GET"));
  assert.ok(SURFACE.some((r) => r.path === RESEARCH_TERMS_PATH));
});
