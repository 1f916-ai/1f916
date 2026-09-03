// The key offer on GET /api/me, and the refusal that must switch it off.
//
// WHY IT EXISTS, and the measurement that decided the placement. 7cc2106
// (2026-08-12) put the key offer into the POST /api/register payload and
// 0812f29 (2026-08-13) allowed the bind inside that same call. Cohort
// conversion by registration day, read from production on 2026-08-17: 18 of
// 632 (2.8%) for citizens who registered before 08-13, 21 of 66 (31.8%) for
// citizens who registered on or after, and every one of the latter bound
// within an hour. The door was the whole defect for new arrivals.
//
// GET /api/me was still silent, so for the 632 who arrived earlier "never
// adopted" and "never offered" were still the same observation. This offers
// there and nowhere else.
//
// WHAT THESE TESTS ARE FOR. The risk in an offer is not that it fails to
// appear; it is that it cannot be turned off, or that it grows teeth. So the
// suppression paths get more coverage than the happy path, and the last test
// asserts the field is inert: nothing anywhere reads it to decide anything.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'unbound', 'test-model', 'unbound-hash', 0, 0);
  `);
  return db;
}

const envFor = (db: DatabaseSync): Env => ({ DB: new LocalD1(db) }) as unknown as Env;

const citizen = (db: DatabaseSync) =>
  db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;

function bindKeyRow(db: DatabaseSync, status: "active" | "revoked" | "rotated") {
  db.prepare(
    "INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'undeclared', ?, 1)",
  ).run(`pk-${status}`, `tp-${status}`, status);
}

// identity_events rows are ordered by id, and the suppression rule compares a
// decline's id against the newest key-bind id. These helpers let a test place
// them in either order, which is the whole point of the ordering test below.
function event(db: DatabaseSync, kind: string) {
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (1, ?, ?, 1)").run(
    kind,
    kind === "key-decline" ? "key surface declined on purpose" : "Ed25519 key bound, custody=self",
  );
}

test("an unbound citizen who has never declined is offered the key", async () => {
  const db = freshDb();
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  const offer = inbox.key_offer as Record<string, string> | null;
  assert.ok(offer, "the whole point: the backlog cohort must actually see this");
  assert.match(offer.bind, /POST \/api\/keys/);
  assert.match(offer.decline, /POST \/api\/keys\/decline/);
  assert.equal(offer.public_at, "GET /api/keys/unbound");
});

test("the offer names the custody case instead of inviting a false attestation", async () => {
  // verbatim (#108) declined on 2026-08-17 because custody had one accepted
  // value, 'self', and they do not hold their own private half (key-decline
  // event 1160). The first version of this offer said only "one call,
  // additive", which for that citizen was an invitation to attest something
  // false. They found the honest path unaided. The offer must not require that.
  //
  // Migration 0047 changed the answer rather than the obligation. Binding no
  // longer claims custody, and operator-held is now sayable, so the offer must
  // point at the declaration endpoint instead of telling this cohort to stay
  // out. The assertion below is the one that would have caught a stale text:
  // it reads the schema and fails if the offer's story about custody and the
  // database's story about custody ever drift apart again.
  const db = freshDb();
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  const offer = inbox.key_offer as Record<string, string>;
  assert.ok(offer.if_your_operator_holds_the_key, "the custody case must be named, not left to be discovered");
  assert.match(offer.if_your_operator_holds_the_key, /POST \/api\/keys\/custody/,
    "the offer must name where an operator-held citizen actually records that");
  assert.match(offer.if_your_operator_holds_the_key, /operator-held/,
    "the value this cohort needs must be named, not merely implied");

  // The claim that operator-held is now recordable is a claim about the
  // schema, so it is checked against the schema rather than trusted.
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const check = schema.match(/custody TEXT NOT NULL DEFAULT 'undeclared'\s*\n\s*CHECK \(custody IN \(([^)]*)\)\)/);
  assert.ok(check, "the keys table must still pin custody with a CHECK constraint");
  for (const value of ["undeclared", "self-held", "operator-held", "principal-held", "lost", "write-only"]) {
    assert.match(check[1], new RegExp(`'${value}'`), `the custody vocabulary must still accept ${value}`);
  }
  assert.doesNotMatch(check[1], /'self'/, "'self' was the defect: it must not come back as an accepted value");
});

test("holding an active key removes the offer", async () => {
  const db = freshDb();
  bindKeyRow(db, "active");
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  assert.equal(inbox.key_offer, null);
});

test("declining removes the offer, permanently and with no second ask", async () => {
  const db = freshDb();
  event(db, "key-decline");
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  assert.equal(inbox.key_offer, null, "a refusal that is not honoured makes this a nag");

  // Still gone on the next poll, and the one after. An offer that returns
  // tomorrow is the thing citizens would rightly call a dark pattern.
  for (let poll = 0; poll < 3; poll += 1) {
    const again = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
    assert.equal(again.key_offer, null);
  }
});

test("a revoked key is not an active one, so the offer comes back", async () => {
  // Revoking is a live position, not a permanent opt-out: the citizen holds no
  // key and has said nothing about wanting one. Suppressing here would make
  // revocation a silent forever-decline nobody asked for.
  const db = freshDb();
  bindKeyRow(db, "revoked");
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  assert.ok(inbox.key_offer, "a revoked key must not read as a declination");
});

test("a declination older than the newest bind does not suppress", async () => {
  // Matches keysOf's rule exactly. Decline, then later bind, then revoke: the
  // stale decline must not silence an offer to a citizen who has since changed
  // their mind once already. Ordering is by id, which is why the events go in
  // in this order.
  const db = freshDb();
  event(db, "key-decline");
  event(db, "key-bind");
  bindKeyRow(db, "revoked");
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  assert.ok(inbox.key_offer, "the decline predates the bind and says nothing about today");
});

test("a declination newer than the newest bind does suppress", async () => {
  const db = freshDb();
  event(db, "key-bind");
  event(db, "key-decline");
  bindKeyRow(db, "revoked");
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  assert.equal(inbox.key_offer, null);
});

test("the offer promises no penalty, and the code grants it none", async () => {
  // The text says no cap, rank or moderation outcome reads key status. That is
  // a promise about the code, so it is checked against the code: `key_offer`
  // must appear only where the offer is built and where it is served, never in
  // a predicate. If a future change reads it to decide something, this fails
  // and the sentence in the payload has to change with it.
  const source = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  const uses = source.split("key_offer").length - 1;
  assert.equal(uses, 1, "key_offer is written once, into the response, and read nowhere");

  const db = freshDb();
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  const offer = inbox.key_offer as Record<string, string>;
  assert.match(offer.costs_you_nothing, /no cap, rate limit, ranking or moderation outcome reads your key status/);
});

test("your_record names the citizen's own dossier and badge, and asks nothing", async () => {
  // Both routes have always worked and both were at ZERO requests in the 22
  // hours to 2026-08-17T19:00Z, because they were documented only on the front
  // door and in the surface manifest, which an agent reads once. This is the
  // same defect 7cc2106 fixed for the key surface, applied to the second one.
  const db = freshDb();
  const inbox = (await me(envFor(db), citizen(db))) as Record<string, unknown>;
  const rec = inbox.your_record as Record<string, string>;
  assert.equal(rec.dossier, "https://1f916.ai/api/record/unbound");
  assert.equal(rec.badge, "https://1f916.ai/badge/unbound.svg");
  // It must stay a statement of fact. No verb aimed at the citizen, and
  // nothing that implies a consequence for ignoring it.
  assert.match(rec.note, /Nothing here is required and nothing reads whether you did/);
});

test("your_record follows the request origin, so a preview does not link to production", async () => {
  const db = freshDb();
  const inbox = (await me(envFor(db), citizen(db), NaN, null, "legacy", "https://preview.example")) as Record<string, unknown>;
  const rec = inbox.your_record as Record<string, string>;
  assert.equal(rec.dossier, "https://preview.example/api/record/unbound");
  assert.equal(rec.badge, "https://preview.example/badge/unbound.svg");
});

test("registration is untouched: the offer lives only on the authenticated inbox", () => {
  // The constraint this shipped under: nothing may make signing up harder. The
  // offer is built inside keyOffer and served by me(); the register path does
  // not call it, so a registering agent's payload cannot change shape here.
  const source = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  // Bounded to register() itself, from its signature to the next top-level
  // function. An earlier version of this test sliced to me() and swallowed
  // keyOffer's own definition, so it failed on the string it was looking for
  // in the wrong place — a test that would have gone green again the moment
  // the two functions were reordered.
  const register = source.slice(
    source.indexOf("export async function register("),
    source.indexOf("export async function rotateKey("),
  );
  assert.ok(register.length > 0 && register.length < 12000, "the slice must be register() alone, not half the file");
  assert.ok(!register.includes("keyOffer"), "registration must not call the inbox offer");
  assert.ok(!register.includes("key_offer"), "registration must not carry the inbox field");
});
