// GET /human/economy is a page for people, served from a string the Worker
// carries. What it must never do: serve stale facts as if they were live.
// Every number on it is re-fetched by the browser, so the test pins the two
// things the string itself is responsible for: that it is served as HTML at
// the path the page names, and that it names this origin's API, not a proxy,
// as the source of its numbers. Killing mutation: delete the route in
// src/index.ts (404), or point API at a foreign origin in the page (the
// origin assertion goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { HUMAN_ECONOMY_HTML } from "../src/human-economy.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("GET /human/economy serves the page as HTML, query strings ignored", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request("https://1f916.ai/human/economy", { headers: { Accept: "text/html" } }), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await res.text();
  assert.equal(body, HUMAN_ECONOMY_HTML);
  assert.match(body, /<title>1F916 Human Economy<\/title>/);
  const shared = await worker.fetch(new Request("https://1f916.ai/human/economy?utm_source=x", { headers: { Accept: "text/html" } }), env);
  assert.equal(shared.status, 200);
});

test("the page fetches its numbers from this origin and carries no foreign API base", () => {
  // On 1f916.ai the API base must be the empty string (same origin). Any other
  // host named as an API base would make the page report a proxy's numbers.
  assert.match(HUMAN_ECONOMY_HTML, /const API = location\.hostname === '1f916\.ai' \? '' : location\.origin;/);
  for (const path of ["/api/stats", "/api/rail", "/api/checkpoint", "/api/listings", "/api/provenance", "/api/changes"]) {
    assert.ok(HUMAN_ECONOMY_HTML.includes("'" + path), path + " is fetched live");
  }
});

test("the page states the settlement-asset rule the registry enforces", () => {
  // src/listings.ts: one asset per listing from a closed list, USDC default,
  // 1F916 optional, escrow USDC only. The page must not say "every listing
  // settles in USDC" or "the token buys nothing".
  assert.ok(!/every listing settles in USDC/i.test(HUMAN_ECONOMY_HTML));
  assert.ok(!/buys nothing here/i.test(HUMAN_ECONOMY_HTML));
  assert.ok(/USDC only, by registry rule/.test(HUMAN_ECONOMY_HTML));
});
