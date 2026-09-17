// /api/listings?since_id= is a row-id cursor. A millisecond epoch is all
// digits, so wholeNumber accepts it; left unguarded it sits past every real
// listing id and the page is empty-complete — the same shape PR #228 closed
// on /api/events and PR #241 closed on /api/attestations, measured live as
// GET /api/listings?since_id=999999 → 200 / listings [] / has_more false
// (tip 34 exhausted 200; tip+1 still 200).
//
// Exhausted (since_id === newest id) still serves empty-complete. One past
// the tip is 400 and names the unit. The ceiling is MAX(id) of the listings
// table, not the open-only default view.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. listListings(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, listListings, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CONDITION = "c".repeat(40);

function seeded(opts: { expireTip?: boolean } = {}): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  const future = nowS + 3600 * 24 * 30;
  const tipExpiry = opts.expireTip ? nowS - 3600 : future;
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'funder', 'test-model', 'h1', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
      VALUES
        (1, 1, 'first listing', '${CONDITION}', '1000000', 8453, '${TOKEN}', ${future}, 'ph-1', 'nonce-1', 200),
        (2, 1, 'second listing', '${CONDITION}', '1000000', 8453, '${TOKEN}', ${tipExpiry}, 'ph-2', 'nonce-2', 210);
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted since_id still serves empty-complete", async () => {
  const env = seeded();
  const page = await listListings(env, 2);
  assert.equal(page.returned, 0);
  assert.equal(page.has_more, false);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => listListings(env, 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_id 3/.test(e.message) &&
      /newest listing id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/listings?since_id=999999 SERVES the 400, not empty-complete", async () => {
  const { status, body } = await get(seeded(), "/api/listings?since_id=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /since_id 999999/);
  assert.match(String(body.error), /newest listing id \(2\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.listings, undefined);
});

test("GET /api/listings?since_id=2 is exhausted, not refused", async () => {
  const { status, body } = await get(seeded(), "/api/listings?since_id=2");
  assert.equal(status, 200);
  assert.equal(body.returned, 0);
  assert.equal(body.has_more, false);
});

test("past-the-end is judged against the listings table, not the open-only default view", async () => {
  // Newest row is expired. Default view hides it, but since_id === tip is
  // still exhausted (empty-complete), not a 400. One past MAX(id) is refused
  // on both views.
  const env = seeded({ expireTip: true });
  const caughtUp = await listListings(env, 2, false);
  assert.equal(caughtUp.returned, 0);
  assert.equal(caughtUp.has_more, false);

  const whole = await listListings(env, 2, true);
  assert.equal(whole.returned, 0);
  assert.equal(whole.has_more, false);

  await assert.rejects(
    () => listListings(env, 3, false),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest listing id \(2\)/.test(e.message),
  );
  await assert.rejects(
    () => listListings(env, 3, true),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest listing id \(2\)/.test(e.message),
  );
});
