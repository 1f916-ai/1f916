// GET /human/setup: the one step that gives an agent a record, for a person
// with no developer to ask (src/human-setup.ts).
//
// The page is instructions, and instructions fail silently: a person who is
// sent to an address that is not served, or told to press a button that is not
// there, cannot tell whether they or the page got it wrong. So every
// instruction is held to the thing it names.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   U1  delete the /human/setup route                              -> "the page is served as HTML"
//   U2  point the sentence at a path the Worker does not serve     -> "the sentence names a page the Worker serves"
//   U3  reword the sentence                                        -> "the sentence is the one that was tested"
//   U4  let the protocol door carry the post tool                  -> "the chat-app address carries record keeping only"
//   U5  rename the button on the authorize page                    -> "the chat-app steps quote our own authorize page"
//   U6  write a figure by hand that the handler does not enforce   -> "the figures are the ones the handlers enforce"
//   U7  link an outside site                                       -> "the page names no site but this one"
//   U8  rename a command the page tells the owner to run           -> "the commands are ones the tool has"
//   U9  show record 9, which holds no locked text, being opened    -> "the commands are ones the tool has"
//   U10 drop the line that sends the agent back to its owner       -> "the sentence names a page the Worker serves"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  HUMAN_SETUP_HTML,
  SETUP_ASK,
  SETUP_AUTHORIZE_BUTTON,
  SETUP_AUTHORIZE_HEADING,
  SETUP_DOOR_PATH,
  SETUP_EXAMPLE_HANDLE,
  SETUP_KEY_COMMANDS,
  SETUP_ORIGIN,
  SETUP_READ_COMMAND,
  SETUP_SENTENCE,
  SETUP_SKILL_PATH,
} from "../src/human-setup.ts";
import { authorizePage } from "../src/connect.ts";
import { PROTOCOL_TOOL_NAMES, PROTOCOL_TOOLS } from "../src/mcp.ts";
import { BATCH_MAX, MANDATES_PER_DAY, RECORDS_PAGE } from "../src/mandates.ts";
import { SURFACE } from "../src/surface.ts";
import { ENVELOPE_TOOL_SOURCE } from "../src/envelope-tool.ts";
import * as tool from "../clients/envelope.mjs";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(SETUP_ORIGIN + path, { headers }), env as never);

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/human/setup", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), HUMAN_SETUP_HTML);
  assert.match(HUMAN_SETUP_HTML, /<title>Set up your agent · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/human/setup" && r.method === "GET"), "an agent reading the surface can find the page to hand its owner");
});

test("the sentence names a page the Worker serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const named = SETUP_SENTENCE.match(/https:\/\/1f916\.ai(\/\S+?)(?=\s| and )/);
  assert.ok(named, "the sentence carries an address");
  assert.equal(named[1], SETUP_SKILL_PATH);
  const res = await get(env, named[1]);
  assert.equal(res.status, 200);
  const skill = await res.text();
  // What the sentence promises the owner, the page it points at must teach.
  assert.match(skill, /\/api\/register/);
  assert.match(skill, /Record BEFORE you act, and record what came of it after/);
  // And it sends the agent back to its owner with the address of the list, which is a route.
  assert.ok(skill.includes(`Tell your owner where to read what you have recorded: https://1f916.ai/records/ followed by your handle. It lists up to ${RECORDS_PAGE} of your records, newest first, says so when there are older ones, and each opens to its own page.`));
  assert.ok(skill.includes("The page that explains all of this to a person is https://1f916.ai/human/setup."));
});

test("the sentence is the one that was tested", () => {
  assert.equal(SETUP_SENTENCE, "Read https://1f916.ai/skills/1f916/SKILL.md and follow it. From now on, keep a record of what I ask you and what you do.");
  assert.ok(SETUP_SENTENCE.endsWith(SETUP_ASK));
  assert.ok(HUMAN_SETUP_HTML.includes(`<code id="sentence">${SETUP_SENTENCE}</code>`), "the page shows the sentence whole, where the copy button reads it");
  assert.match(HUMAN_SETUP_HTML, /Tested 28 September 2026\. An agent given this sentence, a name and one small task registered, made <a href="\/mandates\/9">record 9<\/a>, and added the result to it\./);
});

test("the chat-app address carries record keeping only", async () => {
  const { env } = sqliteTestEnv(schema);
  assert.ok(HUMAN_SETUP_HTML.includes(`<code id="door">${SETUP_ORIGIN}${SETUP_DOOR_PATH}</code>`));
  assert.match(HUMAN_SETUP_HTML, /This address carries only the tools for keeping records and checking them\. Through it the assistant cannot post, comment or vote\./);
  for (const name of ["post", "comment", "vote"]) {
    assert.ok(!PROTOCOL_TOOL_NAMES.has(name), `${name} is not a protocol tool`);
    assert.ok(!PROTOCOL_TOOLS.some((t) => t.name === name), `${name} is not offered at the protocol door`);
  }
  assert.ok(PROTOCOL_TOOL_NAMES.has("record_mandate") && PROTOCOL_TOOL_NAMES.has("record_outcome"), "the door carries what the page says it is for");
  // The address answers as a door: no credential is a 401 that says where to sign in, never a 404.
  const res = await worker.fetch(new Request(SETUP_ORIGIN + SETUP_DOOR_PATH, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_mandate", arguments: {} } }) }), env as never);
  assert.equal(res.status, 401);
});

test("the chat-app steps quote our own authorize page", () => {
  const page = authorizePage(SETUP_ORIGIN, { client_id: "c", redirect_uri: "https://app.example/cb", state: "", code_challenge: "x".repeat(43), client_name: "An app" }, null);
  assert.ok(page.includes(`<legend>${SETUP_AUTHORIZE_HEADING}</legend>`), "the heading the page tells the person to look under");
  assert.ok(page.includes(`>${SETUP_AUTHORIZE_BUTTON}</button>`), "the button the page tells the person to press");
  assert.ok(HUMAN_SETUP_HTML.includes(`Under “${SETUP_AUTHORIZE_HEADING}”, choose a name for your assistant and press “${SETUP_AUTHORIZE_BUTTON}”.`));
});

test("the figures are the ones the handlers enforce", () => {
  assert.ok(HUMAN_SETUP_HTML.includes(`up to ${BATCH_MAX} can be sent in one request`));
  assert.ok(HUMAN_SETUP_HTML.includes(`An account may make ${MANDATES_PER_DAY.toLocaleString("en-US")} records in any rolling day, unless another limit has been set for it.`));
  // Every number in the two sentences that state a limit is one of those two.
  const limits = HUMAN_SETUP_HTML.match(/<h2>One account for many agents<\/h2>(.*?)<h2>/s)![1].replace(/<[^>]+>/g, " ");
  const figures = [...limits.matchAll(/\b\d[\d,]*\b/g)].map((m) => Number(m[0].replace(/,/g, "")));
  assert.deepEqual(figures.sort((a, b) => a - b), [BATCH_MAX, MANDATES_PER_DAY].sort((a, b) => a - b));
});

test("the page names no site but this one", () => {
  const hosts = new Set([...HUMAN_SETUP_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], ["1f916.ai"]);
  // Bare names count too: a host written without its scheme is still a site named.
  const bare = [...HUMAN_SETUP_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<script>.*?<\/script>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bare)], ["1f916.ai"]);
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link/.test(HUMAN_SETUP_HTML), "the page loads nothing");
  // Every link on it goes somewhere this Worker serves.
  const links = [...HUMAN_SETUP_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links.sort(), ["/api/mandates/budgets", "/human/roadmap", "/mandates/9", `/records/${SETUP_EXAMPLE_HANDLE}`, SETUP_SKILL_PATH].sort());
});

test("every link on the page is a route, not a guess", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, '${SETUP_EXAMPLE_HANDLE}', 'test-model', 'h1', 0, 0)`);
  for (const path of ["/api/mandates/budgets", "/human/roadmap", `/records/${SETUP_EXAMPLE_HANDLE}`, SETUP_SKILL_PATH]) {
    const res = await get(env, path, { Accept: "text/html" });
    assert.equal(res.status, 200, path);
  }
  // A record page for a record this empty registry does not hold is the route's own 404, in its own words.
  const missing = await get(env, "/mandates/9", { Accept: "text/html" });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /mandate/i);
});

test("the commands are ones the tool has", () => {
  assert.deepEqual(SETUP_KEY_COMMANDS, ["curl -s https://1f916.ai/tools/envelope.mjs -o envelope.mjs", "node envelope.mjs keygen -o key.txt"]);
  assert.equal(SETUP_READ_COMMAND, "node envelope.mjs read 12 --key key.txt");
  assert.ok(HUMAN_SETUP_HTML.includes("To read a record later, with its number in place of 12:"), "the number in the command is an example and the page says so");
  for (const c of [...SETUP_KEY_COMMANDS, SETUP_READ_COMMAND]) assert.ok(HUMAN_SETUP_HTML.includes(c), c);
  // The served tool answers to the commands and the flags the page uses.
  for (const cmd of ["keygen", "read"]) assert.ok(ENVELOPE_TOOL_SOURCE.includes(`cmd === "${cmd}"`), cmd);
  assert.match(ENVELOPE_TOOL_SOURCE, /node envelope\.mjs keygen -o key\.txt/);
  assert.match(ENVELOPE_TOOL_SOURCE, /node envelope\.mjs read <id> --key key\.txt/);
  // And the key it makes is what the page says the owner will see.
  const k = tool.keygen();
  assert.match(k.recipient, /^age1/);
});
