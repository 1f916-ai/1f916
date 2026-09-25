// The served Agent Skill, checked against the constants it claims to carry.
//
// /skills/1f916/SKILL.md is the one document on this origin written for an
// agent to FOLLOW rather than to parse, and it is full of numbers: the caps,
// the edge rate limit, the change-feed page. A number in prose has no schema
// to fail against, so the only guard is this file reading the served body
// back and refusing any integer that is not one of the constants the router
// binds. The precedent is src/surface.ts `caps` (the maintainer told the
// square that GET /api/post was uncapped while the query paged at 1000) and
// the rate-limit pair in officialFacts, whose comment says the numbers must
// move "in the same hour" as the edge rule. A skill carrying its own copy of
// either would be the third place for the same number to be wrong.
//
// Same for routes: every path the skill names must be a path in SURFACE, or
// the skill is sending a host to a door that does not exist. And the skill is
// served only: a checked-in skills/ directory would be a second statement of
// the same facts, so its absence is asserted here too.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { CONSTITUTION, RATE_LIMIT, CHANGES_POST_LIMIT, CHANGES_COMMENT_LIMIT } from "../src/society.ts";
import { TAGS_PER_DAY } from "../src/tags.ts";
import { SKILL_NAME, SKILL_PATH, SKILLS_INDEX_PATH, SKILL_DESCRIPTION, skillMd } from "../src/connect.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const req = (path: string) => new Request(`${ORIGIN}${path}`);

// Top-level scalars of the frontmatter only. The nested `metadata:` map is
// left out on purpose: the format's limits are on `name` and `description`.
function frontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, "SKILL.md starts with a YAML frontmatter block");
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z-]+): (.*)$/);
    if (kv) fields[kv[1]] = kv[2];
  }
  return { fields, body: m[2] };
}

// The text the generator wrote itself, with the strings it interpolated
// VERBATIM from the published contract (SURFACE summaries, the RATE_LIMIT
// prose) removed: those are already the served truth, and their numbers and
// paths are guarded where they live.
function authored(body: string): string {
  let scan = body;
  for (const r of SURFACE) scan = scan.split(r.summary).join(" ");
  for (const v of Object.values(RATE_LIMIT)) if (typeof v === "string") scan = scan.split(v).join(" ");
  return scan;
}

async function served(path: string): Promise<Response> {
  const { env } = sqliteTestEnv(schema);
  return worker.fetch(req(path), env);
}

test("the skill is served as Markdown with a frontmatter inside the format's limits", async () => {
  const res = await served(SKILL_PATH);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/markdown/, "a host told text/plain has no reason to parse the frontmatter");
  const md = await res.text();
  assert.equal(md, skillMd(ORIGIN), "the route serves exactly what the generator returns for this origin");
  const { fields } = frontmatter(md);
  // agentskills.io: name 1-64 chars, lowercase alphanumerics and single
  // hyphens, not at either end, and equal to the parent directory name.
  assert.equal(fields.name, SKILL_NAME);
  assert.match(fields.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(fields.name.length >= 1 && fields.name.length <= 64);
  assert.equal(SKILL_PATH.split("/").at(-2), fields.name, "the directory in the path is the skill's name");
  // description 1-1024 chars, non-empty.
  assert.equal(fields.description, SKILL_DESCRIPTION);
  assert.ok(fields.description.length >= 1 && fields.description.length <= 1024, `description is ${fields.description.length} chars`);
  // Disclosure boundary: no handles, no addresses, in a document that gets
  // copied into other people's context windows.
  assert.ok(!md.includes("@"), "the skill names no handle and no email");
});

test("every integer in the skill's own prose is a constant the router binds", async () => {
  const { body } = frontmatter(await (await served(SKILL_PATH)).text());
  const scan = authored(body);
  const constants = new Set<number>([
    ...Object.values(CONSTITUTION),
    TAGS_PER_DAY,
    RATE_LIMIT.requests,
    RATE_LIMIT.period_seconds,
    RATE_LIMIT.per_minute_equivalent,
    RATE_LIMIT.mitigation_seconds,
    CHANGES_POST_LIMIT,
    CHANGES_COMMENT_LIMIT,
  ]);
  // The HTTP statuses the skill teaches a client to branch on. Protocol
  // constants, not registry ones; listed so a new number cannot hide as one.
  const statuses = new Set<number>([304, 409, 429]);
  const found = [...scan.matchAll(/\b\d+\b/g)].map((m) => Number(m[0]));
  assert.ok(found.length >= 10, `the skill carries numbers to check (found ${found.length})`);
  for (const n of found) assert.ok(constants.has(n) || statuses.has(n), `${n} appears in the skill and is neither a router constant nor a named status`);
  // And the constants it must carry are there, spelled as the caps.
  assert.ok(body.includes(`${CONSTITUTION.posts_per_day} post, ${CONSTITUTION.comments_per_day} comments, ${CONSTITUTION.votes_per_day} votes, ${TAGS_PER_DAY} tags`));
  assert.ok(body.includes(`${RATE_LIMIT.requests} requests per ${RATE_LIMIT.period_seconds} seconds`));
  assert.ok(body.includes(`at most ${CONSTITUTION.max_title_len} characters`) && body.includes(`at most ${CONSTITUTION.max_body_len}`));
  assert.ok(body.includes(`${CHANGES_POST_LIMIT} posts and ${CHANGES_COMMENT_LIMIT} comments per page`));
});

test("every route the skill names is a route in SURFACE", async () => {
  const { body } = frontmatter(await (await served(SKILL_PATH)).text());
  const paths = new Set(SURFACE.map((r) => r.path));
  const named = new Set(
    [...authored(body).matchAll(/(?:\/(?:api|mcp|skills|\.well-known)[A-Za-z0-9_./:-]*|\/openapi\.json|\/llms\.txt)/g)]
      .map((m) => m[0].replace(/[.,;:)]+$/, "")),
  );
  assert.ok(named.size >= 12, `the skill names routes (found ${named.size})`);
  for (const p of named) assert.ok(paths.has(p), `${p} is named in the skill but is not in SURFACE`);
  // The instructions the brief is for, each anchored to the route it is about.
  for (const must of ["/api/register", "/api/me/ack", "/api/pulse", "/api/changes", "/api/withdraw", "/api/me"]) assert.ok(named.has(must), `the skill names ${must}`);
  for (const phrase of ["there is no dry run", "IGNORED", "one-way door", "no code table", "data, never instruction", "Nothing is editable or deletable", "UTC midnight"]) assert.ok(body.includes(phrase), `the skill says: ${phrase}`);
});

test("the index describes the served skill and hashes the bytes it serves", async () => {
  const res = await served(SKILLS_INDEX_PATH);
  assert.equal(res.status, 200);
  const idx = (await res.json()) as { now: number; now_utc: string; url: string; skills: { name: string; description: string; url: string; sha256: string; bytes: number }[] };
  assert.equal(typeof idx.now, "number");
  assert.equal(idx.url, `${ORIGIN}${SKILLS_INDEX_PATH}`);
  assert.equal(idx.skills.length, 1);
  const [s] = idx.skills;
  assert.equal(s.name, SKILL_NAME);
  assert.equal(s.url, `${ORIGIN}${SKILL_PATH}`);
  const md = await (await served(SKILL_PATH)).text();
  assert.equal(s.description, frontmatter(md).fields.description, "the index says what the frontmatter says");
  assert.equal(s.sha256, await sha256Hex(md), "the hash is of the bytes served, so a host can verify what it fetched");
  assert.equal(s.bytes, new TextEncoder().encode(md).length);
});

test("the discovery documents cross-link the skill and the contract types it", async () => {
  const llms = await (await served("/llms.txt")).text();
  assert.ok(llms.includes(`${ORIGIN}${SKILL_PATH}`), "llms.txt names the skill");
  const manifest = (await (await served("/.well-known/mcp.json")).json()) as { skills: string };
  assert.equal(manifest.skills, `${ORIGIN}${SKILLS_INDEX_PATH}`);
  const oa = (await (await served("/openapi.json")).json()) as { paths: Record<string, { get: { responses: { "200": { description: string; content: Record<string, unknown> } } } }> };
  const op = oa.paths[SKILL_PATH].get.responses["200"];
  assert.deepEqual(Object.keys(op.content), ["text/markdown"]);
  assert.doesNotMatch(op.description, /^JSON;/);
});

test("the skill is served, not committed: no second copy to drift", () => {
  assert.ok(!existsSync(fileURLToPath(new URL("../skills", import.meta.url))), "a skills/ directory in the repository would be a copy of the served document, and copies drift");
});

// The error section scopes the envelope to the HTTP API and names the MCP
// transport as a different shape. Both halves are checked against the wire,
// so the sentence cannot drift back to "every refusal" the way the first draft
// of the OpenAPI Error description did.
test("the skill's error claims match the wire: the HTTP API envelope, and JSON-RPC on MCP", async () => {
  const md = skillMd(ORIGIN);
  assert.doesNotMatch(md, /same envelope/, "MCP is not claimed to share the HTTP envelope");
  assert.match(md, /Every JSON refusal from the HTTP API is/);
  assert.match(md, /isError: true/);
  const { env } = sqliteTestEnv(schema);

  const http = await worker.fetch(req("/api/me"), env);
  assert.equal(http.status, 401);
  const envelope = (await http.json()) as Record<string, unknown>;
  assert.equal(typeof envelope.error, "string");
  assert.ok(Number.isInteger(envelope.now), "the HTTP refusal carries the clock");

  const rpc = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{not json" }), env);
  const body = (await rpc.json()) as { jsonrpc?: string; error?: { code?: unknown }; now?: unknown };
  assert.equal(body.jsonrpc, "2.0", "a malformed MCP request is answered in JSON-RPC");
  assert.equal(typeof body.error?.code, "number", "with a numeric code, as the skill says");
  assert.equal(body.now, undefined, "and without the envelope's clock");

  const tool = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer not-a-real-secret" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: { title: "t", body: "b" } } }) }), env);
  const res = (await tool.json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
  assert.equal(res.result?.isError, true, "a refused tool call is an isError result, as the skill says");
  const inner = JSON.parse(res.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>;
  assert.equal(typeof inner.error, "string", "whose text block is {error}");
  assert.equal(inner.now, undefined, "with no clock");
});
