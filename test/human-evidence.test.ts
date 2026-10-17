// GET /human/evidence: log integrity evidence, for an audit (src/human-evidence.ts).
//
// The page quotes a standard, maps a record onto it, and tells an auditor what
// to run. A misquoted control, a claim the standard does not make, a command
// that names a route the Worker does not serve, or a figure without its date
// would each put a false sentence in front of the one reader who checks.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   V1  delete the /human/evidence route                       -> "the page is served as HTML"
//   V2  reword one quotation                                   -> "the quotations are the text as read, and are shown whole"
//   V3  call the control "required" or the record "certified"  -> "the page never says the control is required or the record certified"
//   V4  tell the auditor to curl a path the Worker does not serve -> "every command names a route the Worker serves"
//   V5  give the checker a flag it does not have               -> "the checker flags are the checker's own"
//   V6  write "confirmed" of a Bitcoin anchor                  -> "a Bitcoin anchor is never called confirmed"
//   V7  drop the date from the figure, or from the reading     -> "the figure and the reading carry their date"
//   V8  link an outside site                                   -> "the page links nowhere but here"
//   V9  change the text cap by hand                            -> "the text cap is the one the seal door enforces"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  E015_4_EVIDENCE,
  E015_4_TEXT,
  E015_4_TITLE,
  E015_SIBLINGS,
  E015_TEXT,
  E015_TITLE,
  EVIDENCE_CHECKER_COMMAND,
  EVIDENCE_CHECKER_PATH,
  EVIDENCE_COMMANDS,
  EVIDENCE_ORIGIN,
  EVIDENCE_READ_DATE,
  EVIDENCE_RESEARCH_PATH,
  EVIDENCE_ROUTES,
  EVIDENCE_SETUP_PATH,
  EVIDENCE_STANDARD_SITE,
  EVIDENCE_SNAPSHOT,
  HUMAN_EVIDENCE_HTML,
} from "../src/human-evidence.ts";
import { SEAL_TEXT_MAX } from "../src/seals.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(EVIDENCE_ORIGIN + path, { headers }), env as never);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = HUMAN_EVIDENCE_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/human/evidence", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), HUMAN_EVIDENCE_HTML);
  assert.match(HUMAN_EVIDENCE_HTML, /<title>Log integrity evidence · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/human/evidence" && r.method === "GET"));
});

test("the quotations are the text as read, and are shown whole", () => {
  // Pinned to the standard's pages as read on 6 October 2026. A change here
  // without a new reading is the mutation this test exists to catch.
  assert.equal(E015_TITLE, "Log AI system activity");
  assert.equal(E015_TEXT, "Maintain logs of AI system processes, actions, and agent outputs where permitted to support incident investigation, auditing, and explanation of AI system behavior");
  assert.equal(E015_4_TITLE, "Log integrity protection");
  assert.equal(E015_4_TEXT, "Implementing technical controls to ensure logs are tamper-evident and independently verifiable. For example, ensuring that captured records cannot be modified or deleted after creation, ensuring sequence integrity so that gaps, omissions, and reordering are detectable during incident investigation or audit.");
  assert.equal(E015_4_EVIDENCE, "Log immutability controls - for example, write-once-read-many (WORM) storage configuration, cryptographic hashing of log entries, append-only database settings, or third-party log management platform features.");
  assert.deepEqual(E015_SIBLINGS.map((s) => `${s.id} ${s.title} ${s.level}`), ["E015.1 Logging implementation mandatory", "E015.2 AI agent logging implementation supplemental", "E015.3 Log storage mandatory"]);
  for (const q of [E015_TEXT, E015_4_TEXT, E015_4_EVIDENCE]) assert.ok(HUMAN_EVIDENCE_HTML.includes(`<blockquote>${esc(q)}</blockquote>`), q.slice(0, 40));
  assert.ok(HUMAN_EVIDENCE_HTML.includes(`“${E015_TITLE}”, is labelled mandatory:`));
  assert.ok(HUMAN_EVIDENCE_HTML.includes(`The control's line on that row, “E015.4 Config: ${E015_4_TITLE}”, is labelled a supplemental control, and the evidence it names is:`));
  assert.ok(HUMAN_EVIDENCE_HTML.includes("Its row describes the control as:</p>"));
  // The page claims nothing about the standard beyond the cited pages: no purpose, no definition of the labels.
  assert.doesNotMatch(text, /written for audits|insurance/i);
  assert.match(text, /The pages read define neither label; we read supplemental as not required/);
});

test("the page never says the control is required or the record certified", () => {
  // "not required" is the one place the word may appear: the page's reading of "supplemental".
  assert.doesNotMatch(text.replace(/\bnot required\b/g, ""), /\brequired\b|\brequires\b|\bcertified\b|\bcompliant\b|\bcompliance\b|\bendorse/i);
  assert.match(text, /We are not an auditor, certify nothing, and have no connection to the standard's authors/);
  assert.match(text, /what counts as evidence is the auditor's call/);
  assert.match(text, /from the first signed head after it was sealed; a stamp is attempted every five minutes\. It does not prove the record was true or complete/);
  assert.match(text, /unless it asks for the text to be kept openly, the registry fingerprints it and keeps nothing/);
  assert.match(text, /registry's one chain, in which every entry since the chain began carries a hash, and every one after the first of them commits to the one before it, whoever wrote that one/);
  assert.match(text, /Once a head covers it, it has a fixed position in a tree whose signed head is published at\s+\/api\/checkpoint\s+by a stamp attempted every five minutes; witnesses that are not us countersign the heads they see, on schedules of their own/);
  assert.match(text, /Every event since the chain began has a position in a signed tree once a head covers it/);
  assert.match(text, /once a head covers them, fixed tree positions/);
  // The siblings are named in the standard's own capitalisation.
  assert.ok(text.includes("E015.2 (AI agent logging implementation, supplemental)"));
  assert.doesNotMatch(text, /hourly/);
  assert.match(text, /The witnesses registered here, each with the address of its copies and its public key where it gave one/);
  assert.match(text, /Nothing on this page should be read as their answer/);
});

test("every command names a route the Worker serves", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'some-agent', 'test-model', 'h1', 0, 0)");
  for (const cmd of EVIDENCE_COMMANDS) assert.ok(HUMAN_EVIDENCE_HTML.includes(`<pre>${esc(cmd)}</pre>`), cmd);
  // Each placeholder route, filled in, is answered by a handler and not by the 404 fallthrough.
  const filled: Record<string, string> = {
    record: "/api/mandates/1",
    proof: "/api/proof?log=identity_events&event=1",
    witnesses: "/api/witnesses",
    anchors: "/api/anchors",
    dossier: "/api/record/some-agent",
    consistency: "/api/checkpoint/consistency?log=identity_events&from=1&to=2",
    checkpoint: "/api/checkpoint",
  };
  assert.deepEqual(Object.keys(filled).sort(), Object.keys(EVIDENCE_ROUTES).sort());
  for (const [name, path] of Object.entries(filled)) {
    const res = await get(env, path);
    const body = await res.text();
    // The router's fallthrough is a 404 carrying did_you_mean; a handler's own
    // 404 ("no record 1") or 503 (no signing key in this env) is still a route.
    assert.ok(!(res.status === 404 && body.includes("did_you_mean")), `${name}: ${path} fell through the router`);
    assert.ok(res.status !== 500, `${name}: ${res.status}`);
    assert.ok(SURFACE.some((r) => r.method === "GET" && r.path === EVIDENCE_ROUTES[name as keyof typeof EVIDENCE_ROUTES].replace(/\?.*$/, "").replace(/<id>/, ":id").replace(/<handle>/, ":handle")), `${name} is on the surface`);
  }
  // The routes on the page are the ones the commands use, placeholders and all.
  assert.ok(EVIDENCE_COMMANDS[0].endsWith(EVIDENCE_ROUTES.record));
  assert.ok(EVIDENCE_COMMANDS[1].includes(EVIDENCE_ROUTES.proof));
  assert.ok(EVIDENCE_COMMANDS[4].includes(`${EVIDENCE_ROUTES.dossier} > record.json`));
});

test("the checker flags are the checker's own", () => {
  const checker = readFileSync(fileURLToPath(new URL("../vendor/protocol/verify.mjs", import.meta.url)), "utf8");
  assert.ok(checker.includes("node verify.mjs --dossier record.json --registry-key <b64url>"), "the checker documents the dossier mode the page uses");
  const flags = EVIDENCE_CHECKER_COMMAND.match(/--[a-z-]+/g)!;
  assert.deepEqual(flags, ["--dossier", "--registry-key"]);
  for (const f of flags) assert.ok(checker.includes(`"${f.slice(2)}"`) || checker.includes(`args.${f.slice(2)}`) || checker.includes(`args["${f.slice(2)}"]`), f);
  assert.ok(EVIDENCE_COMMANDS[4].endsWith(EVIDENCE_CHECKER_COMMAND));
  assert.equal(EVIDENCE_CHECKER_PATH, "/source/protocol/verify.mjs");
  // The key the command wants is published under the name the page gives it.
  assert.match(text, /registry's public key as\s+\/api\/checkpoint\s+publishes it/);
  assert.ok(EVIDENCE_CHECKER_COMMAND.includes("<registry_public_key>"));
});

test("a Bitcoin anchor is never called confirmed", () => {
  assert.doesNotMatch(text, /confirmed (in|on|by) Bitcoin|Bitcoin (anchor|row|copy)s? (is|are|was|were) confirmed/i);
  assert.match(text, /A Bitcoin row stays\s+pending\s+here by design; the reader confirms it with an OpenTimestamps client, and this page calls none of them confirmed/);
  assert.match(text, /offered to Bitcoin \(through OpenTimestamps\), to Base and to the Internet Archive/);
});

test("the figure and the reading carry their date", () => {
  assert.match(EVIDENCE_READ_DATE, /^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
  // One figure on both pages: the research snapshot's, with the head's coverage and the unchained rows beside it.
  assert.ok(text.includes(`At the research snapshot of ${EVIDENCE_SNAPSHOT.date} the log held ${EVIDENCE_SNAPSHOT.events.toLocaleString("en-US")} entries, of which the newest signed head covered ${EVIDENCE_SNAPSHOT.tree_size.toLocaleString("en-US")}; the first ${EVIDENCE_SNAPSHOT.unchained_rows} were written before the chain began.`));
  assert.equal(EVIDENCE_SNAPSHOT.events - EVIDENCE_SNAPSHOT.tree_size, EVIDENCE_SNAPSHOT.unchained_rows);
  assert.ok(text.includes(`Read ${EVIDENCE_READ_DATE} from the standard's evidence guidance and its accountability domain at ${EVIDENCE_STANDARD_SITE}.`));
  assert.ok(text.includes(`On ${EVIDENCE_READ_DATE} we sent the standard's authors a suggestion`));
});

test("the page links nowhere but here, and names the standard's site only as the place it was read", () => {
  const hosts = new Set([...HUMAN_EVIDENCE_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], ["1f916.ai"]);
  const bare = [...HUMAN_EVIDENCE_HTML.replace(/<style>.*?<\/style>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bare)].sort(), ["1f916.ai", EVIDENCE_STANDARD_SITE].sort());
  assert.equal(EVIDENCE_STANDARD_SITE, "standard.aiuc-1.com");
  // The standard's site is named as a citation in text, never linked.
  const links = [...HUMAN_EVIDENCE_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), [EVIDENCE_CHECKER_PATH, EVIDENCE_SETUP_PATH, EVIDENCE_RESEARCH_PATH].sort());
  assert.ok(SURFACE.some((r) => r.path === EVIDENCE_RESEARCH_PATH && r.method === "GET"));
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link|<script/.test(HUMAN_EVIDENCE_HTML), "the page loads and runs nothing");
});

test("the text cap is the one the seal door enforces", () => {
  assert.ok(text.includes(`up to ${SEAL_TEXT_MAX.toLocaleString("en-US")} characters`));
  assert.equal(SEAL_TEXT_MAX, 16_000);
});
