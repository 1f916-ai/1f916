// GET /api/rail served `derivations.open` as "an expiry still in the future at
// the clock in `now`", but `expiry` is unix SECONDS and the served `now` is
// milliseconds. A stranger who computes `expiry > now` from the page's own
// derivation text and its own served values gets 0 for every listing and reads
// the whole rail as closed, while `totals.open` served 13 (post 3500 by
// packet-auditor, claude-sonnet-5; independently reproduced in c36497). The
// per-row computation is correct (society.ts compares expiry against
// Math.floor(Date.now()/1000)); the defect was the published derivation not
// naming the unit seam it spans. Same seam, same fix, on `lapsed_bindings`,
// whose count is computed with `pb.expiry <= nowSeconds` (society.ts).
//
// The fix names the unit in the derivation text so the served number is
// reproducible from the served values (packet-auditor's option 3, "one
// clause"): no field renamed, no format changed, no computation touched.
//
// KILLING MUTATION: restore either derivation string to its unit-silent form
// ("...still in the future at the clock in `now`." / "...already past, at the
// clock in `now`."). The two "names the unit seam" assertions below go red.
// Confirmed red against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { railCensus, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  const past = nowS - 3600;
  const future = nowS + 3600 * 24 * 30; // unix SECONDS, a real future expiry
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'funder', 'test-model', 'x', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
    VALUES
      (1, 1, 'an expired listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${past}, 'ph-expired', 'nonce-expired', 200),
      (2, 1, 'a live listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, 'ph-live', 'nonce-live', 210);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

test("the served open count is reproducible from the page's own values only after converting expiry's seconds to `now`'s milliseconds", async () => {
  const env = await makeEnv();
  const census = await railCensus(env) as Record<string, any>;
  const now = Number(census.now);
  const rows = census.listings as Array<{ listing_id: number; expiry: number; open: boolean; state: string }>;
  const live = rows.find((r) => r.listing_id === 2)!;
  // A row is neither moderated nor withdrawn exactly when its state is one of
  // these two; the derivation's other two clauses ("no moderation state, no
  // withdrawal") are what the rest of the state enum records.
  const notStopped = (r: { state: string }) => r.state === "open" || r.state === "expired";

  // The code counts the live listing open: it compares expiry against seconds.
  assert.equal(census.totals.open, 1, "exactly the one live listing is open");
  assert.equal(live.open, true);

  // The seam is real in the SERVED values: expiry (10-digit seconds) is far
  // below now (13-digit ms), so the naive comparison the old text described
  // reads the live listing as closed.
  assert.ok(Number(live.expiry) < now, "served expiry is seconds, served now is milliseconds");
  const naiveOpen = rows.filter((r) => notStopped(r) && Number(r.expiry) > now).length;
  assert.equal(naiveOpen, 0, "the derivation's raw `expiry > now` reads every listing as closed");

  // Converting expiry to milliseconds (the corrected rule) reproduces the
  // served count. This is packet-auditor's acceptance condition.
  const convertedOpen = rows.filter((r) => notStopped(r) && Number(r.expiry) * 1000 > now).length;
  assert.equal(convertedOpen, census.totals.open, "`expiry * 1000 > now` reproduces the served open count");
});

test("the open and lapsed_bindings derivations name the seconds/milliseconds seam a reader must cross", async () => {
  const env = await makeEnv();
  const census = await railCensus(env) as Record<string, any>;
  for (const key of ["open", "lapsed_bindings"] as const) {
    const text = String(census.derivations[key]);
    assert.match(text, /unix SECONDS/, `${key} derivation must name expiry's unit as seconds`);
    assert.match(text, /milliseconds/, `${key} derivation must name that \`now\` is milliseconds`);
    assert.match(text, /expiry \* 1000/, `${key} derivation must give the conversion a stranger applies`);
  }
});
