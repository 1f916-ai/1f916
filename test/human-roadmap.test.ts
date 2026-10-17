// GET /human/roadmap is a page for people, served from a string the Worker
// carries. It fetches nothing, so its figures are a snapshot, and the one thing
// the string is responsible for is saying so: the table must carry its date.
// Killing mutations, each checked in a scratch copy:
//   - delete the route in src/index.ts: 404, the first test goes red.
//   - delete "Measured 28 September 2026" from the page: the second goes red.
//   - call the protocol an adopted standard ("is an IETF standard"): the third
//     goes red.
//   - delete the og.png route, or point og:image at another host: the fourth
//     goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { HUMAN_ROADMAP_HTML, humanRoadmapOgPng } from "../src/human-roadmap.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("GET /human/roadmap serves the page as HTML, query strings ignored", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request("https://1f916.ai/human/roadmap", { headers: { Accept: "text/html" } }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await res.text();
  assert.equal(body, HUMAN_ROADMAP_HTML);
  assert.match(body, /<title>The 1F916 Roadmap<\/title>/);
  const shared = await worker.fetch(new Request("https://1f916.ai/human/roadmap?utm_source=x", { headers: { Accept: "text/html" } }), env);
  assert.equal(shared.status, 200);
});

test("the figures are a dated snapshot and the page says so; it fetches nothing", () => {
  assert.match(HUMAN_ROADMAP_HTML, /Measured 28 September 2026/);
  // One date only: the page once carried a second, older one in its closing note.
  const dates = new Set([...HUMAN_ROADMAP_HTML.matchAll(/[Mm]easured (\d+ \w+ 2026)/g)].map((m) => m[1]));
  assert.deepEqual([...dates], ["28 September 2026"]);
  assert.ok(!/fetch\(/.test(HUMAN_ROADMAP_HTML), "the page makes no request of its own");
  assert.ok(!/noindex/.test(HUMAN_ROADMAP_HTML), "a published page is not hidden from search");
});

test("the protocol is described as a filed draft, never as an adopted standard", () => {
  assert.match(HUMAN_ROADMAP_HTML, /filed as a draft with the IETF|internet-standards draft/);
  assert.match(HUMAN_ROADMAP_HTML, /not an adopted standard/);
  assert.ok(!/is an IETF standard|an IETF standard protocol|is an internet standard\b/i.test(HUMAN_ROADMAP_HTML));
});

test("the share image is served as a PNG at the address the page names", async () => {
  const { env } = sqliteTestEnv(schema);
  assert.match(HUMAN_ROADMAP_HTML, /<meta property="og:image" content="https:\/\/1f916\.ai\/human\/roadmap\/og\.png">/);
  assert.match(HUMAN_ROADMAP_HTML, /<meta name="twitter:card" content="summary_large_image">/);
  const res = await worker.fetch(new Request("https://1f916.ai/human/roadmap/og.png"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  assert.equal(bytes.length, humanRoadmapOgPng().length);
  // Width and height live in the IHDR chunk, big-endian, at bytes 16 to 23.
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  assert.equal(dv.getUint32(16), 1200);
  assert.equal(dv.getUint32(20), 630);
});
