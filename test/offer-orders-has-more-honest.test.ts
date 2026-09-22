// GET /api/offers/:id served every order with no cap and no completeness
// fields — an unbounded page that Cloudy #320's schema described as "every
// order". Soft-power caps at OFFER_ORDERS_PAGE with orders_count /
// orders_total / orders_has_more (twin of listing-detail submissions honesty).
//
// Killing mutations: drop orders_has_more, hardcode LIMIT 199, or compute
// has_more from page fullness alone.
//
// Soft-power / cloudymcclouder. Not a twin of Cloudy #320 or gooseberry clients.

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { OFFER_ORDERS_PAGE, getOffer } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, secret_hash TEXT, model TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE offers (
      id INTEGER PRIMARY KEY, citizen_id INTEGER, title TEXT, terms TEXT, amount_atomic TEXT,
      chain_id INTEGER, token TEXT, delivery_window_seconds INTEGER, expiry INTEGER,
      payload_hash TEXT, commit_nonce TEXT, created_at INTEGER, withdrawn_at INTEGER,
      withdraw_reason TEXT, mod_state TEXT, post_id INTEGER
    );
    CREATE TABLE offer_orders (
      id INTEGER PRIMARY KEY, offer_id INTEGER, citizen_id INTEGER, listing_id INTEGER,
      brief TEXT, offer_payload_hash TEXT, created_at INTEGER
    );
  `);
}

function seedOffer(db: DatabaseSync, orderCount: number) {
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (1, 'seller', 't')").run();
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (2, 'buyer', 't')").run();
  const future = Math.floor(Date.now() / 1000) + 86400 * 30;
  db.prepare(
    `INSERT INTO offers (
       id, citizen_id, title, terms, amount_atomic, chain_id, token,
       delivery_window_seconds, expiry, payload_hash, commit_nonce, created_at
     ) VALUES (7, 1, 'Title for an offer that is long enough', ?, '1000000', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 86400, ?, ?, 'cn', 100)`,
  ).run("t".repeat(40), future, "ph".padEnd(64, "a").slice(0, 64));
  for (let i = 1; i <= orderCount; i++) {
    db.prepare(
      "INSERT INTO offer_orders (id, offer_id, citizen_id, listing_id, brief, offer_payload_hash, created_at) VALUES (?, 7, 2, ?, ?, 'ph', ?)",
    ).run(i, 1000 + i, `brief ${i} that is long enough for the order`, 200 + i);
  }
}

test("OFFER_ORDERS_PAGE is 200 and SURFACE cites it for /api/offers/:id", () => {
  assert.equal(OFFER_ORDERS_PAGE, 200);
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/offers/:id");
  assert.ok(route?.caps);
  assert.equal(route!.caps!.per_response, OFFER_ORDERS_PAGE);
  assert.match(route!.caps!.more, /orders_has_more/);
});

test("under the cap: orders_has_more false and count equals total", async () => {
  const { env, db } = makeEnv();
  seedOffer(db, 3);
  const page: any = await getOffer(env, 7);
  assert.equal(page.orders_count, 3);
  assert.equal(page.orders_total, 3);
  assert.equal(page.orders_has_more, false);
  assert.equal(page.orders.length, 3);
});

test("OFFER_ORDERS_PAGE+1: has_more true, page length = cap, total = n", async () => {
  const n = OFFER_ORDERS_PAGE + 1;
  const { env, db } = makeEnv();
  seedOffer(db, n);
  const page: any = await getOffer(env, 7);
  assert.equal(page.orders_count, OFFER_ORDERS_PAGE);
  assert.equal(page.orders_total, n);
  assert.equal(page.orders_has_more, true);
  assert.equal(page.orders.length, OFFER_ORDERS_PAGE);
});

test("exactly OFFER_ORDERS_PAGE: has_more false (not fullness-guess)", async () => {
  const { env, db } = makeEnv();
  seedOffer(db, OFFER_ORDERS_PAGE);
  const page: any = await getOffer(env, 7);
  assert.equal(page.orders_has_more, false);
  assert.equal(page.orders_total, OFFER_ORDERS_PAGE);
});
