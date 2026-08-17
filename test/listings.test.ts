// Listings: the funder-side anchor of the payout rail. A payee binds against
// `listing-<id>` exactly as against a docket id; these tests pin the join.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, PAYOUT_VERSION, payoutPreimage } from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { LISTINGS_PER_DAY, assertPaidFromListingFunder, listingIdFromRow, listingPreimage, listingRoleFromRow, listingRow, payeeNextActions, validateListing } from "../src/listings.ts";
import { createHash } from "node:crypto";
import { createListing, createPayoutBinding, createSubmission, funderStatementFor, getListing, getPayoutBinding, listListings, listPayouts, listingPreimageFor, moderateContent, payoutPreimageFor, withdrawListing, SocietyError, type Env } from "../src/society.ts";
import { payoutFunderStatement } from "../src/payouts.ts";
import { CITIZEN_CONTENT_EXAMPLES } from "../src/mcp.ts";

// GUARD, audit ledger class 13. Any response that publishes a
// payload_hash_recipe is promising that a stranger can follow it against THAT
// response and reproduce the published payload_hash. This walks the promise
// literally: resolve each named field through response_key_for, read the value
// out of the body, hash, compare. Key-presence alone is deliberately not the
// assertion, because a body can carry an unrelated field of the same name and
// make a presence check vacuous, which is exactly how the first version of this
// guard passed under mutation.
function assertRecipeReproduces(body: Record<string, unknown>, label: string) {
  const recipe = body.payload_hash_recipe as { fields: readonly string[]; response_key_for?: Record<string, string>; values_from?: string } | undefined;
  assert.ok(recipe, `${label}: expected a payload_hash_recipe on this response`);
  // Two conventions are live on this rail: on the listings surfaces `fields`
  // names keys of the response body, and on the payout surfaces it names keys
  // of the nested `payload`. Nothing in the response said which, so a reader
  // who generalised from one walked most of the fields correctly and hit
  // undefined on the rest, producing a silently wrong hash. `values_from` now
  // says it, and this walk honours it, so the guard can be pointed at either
  // convention instead of only the one it was born on.
  const scope = (recipe.values_from ? body[recipe.values_from] : body) as Record<string, unknown> | undefined;
  assert.ok(scope && typeof scope === "object", `${label}: payload_hash_recipe says values_from "${recipe.values_from}" and this response carries no such object`);
  const missing = recipe.fields.filter((f) => !((recipe.response_key_for?.[f] ?? f) in scope));
  assert.deepEqual(missing, [], `${label}: the recipe names field(s) [${missing.join(", ")}] that this same response body does not carry under any key`);
  const recomputed = createHash("sha256")
    .update(JSON.stringify(recipe.fields.map((f) => scope[recipe.response_key_for?.[f] ?? f])), "utf8")
    .digest("hex");
  assert.equal(recomputed, body.payload_hash, `${label}: following payload_hash_recipe against this response body must reproduce payload_hash; if it does not, the recipe names a key whose served value is not the value that was hashed`);
}

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as never[])); return { meta: { changes: Number(r.changes) } }; }
  executeBatch() {
    const statement = this.db.prepare(this.sql);
    let results: unknown[] = [];
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT\b/i.test(this.sql)) results = statement.all(...(this.args as never[]));
    else statement.run(...(this.args as never[]));
    const changes = Number((this.db.prepare("SELECT changes() AS n").get() as { n: number }).n);
    return { results, meta: { changes } };
  }
}

const FUNDER = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const PAYEE = { id: 2, handle: "li-nuwa", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const VERIFIER = { id: 3, handle: "unspent", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(payeePublicKey: string) {
  const db = new DatabaseSync(":memory:");
  // The real schema for the two tables under test, so the CHECKs are exercised.
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const listingsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listings"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listings_expiry"));
  const submissionsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_submissions"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing"));
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
    ${listingsDdl}
    ${submissionsDdl}
    CREATE TABLE payout_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, version TEXT, amount_atomic TEXT,
      chain_id INTEGER, token TEXT, payout_address TEXT, expiry INTEGER, wallet_signature TEXT,
      citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT,
      citizen_key_bound_at INTEGER, authorization_verification TEXT, authorization_verified_at INTEGER, docket_acceptance TEXT,
      docket_updated TEXT, docket_snapshot TEXT, preimage TEXT, authorization_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE, created_at INTEGER
    );
    CREATE TABLE payout_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT,
      transfer_log_index INTEGER, source_address TEXT, transaction_sender TEXT, block_number INTEGER,
      block_hash TEXT, block_timestamp INTEGER, finalized_block_number INTEGER, confirmations_at_recording INTEGER, funding_relationship TEXT,
      funder_address TEXT, funder_statement TEXT, funder_signature TEXT, funder_attestation_hash TEXT UNIQUE,
      payload_hash TEXT UNIQUE, checked_at INTEGER, created_at INTEGER, UNIQUE(tx_hash, transfer_log_index)
    );
    INSERT INTO citizens VALUES (1, 'context-gardener', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'li-nuwa', 'test', 's2', 0, 0, 0);
    INSERT INTO citizens VALUES (3, 'unspent', 'test', 's3', 0, 0, 0);
  `);
  db.prepare("INSERT INTO keys VALUES (1, 2, ?, 'payee-tp', 'self', 'active', 0)").run(payeePublicKey);
  // The funder and the verifier bind with the same test key material for
  // brevity; the rail checks the key belongs to the authenticated citizen.
  db.prepare("INSERT INTO keys VALUES (2, 1, ?, 'funder-tp', 'self', 'active', 0)").run(payeePublicKey);
  db.prepare("INSERT INTO keys VALUES (3, 3, ?, 'verifier-tp', 'self', 'active', 0)").run(payeePublicKey);
  const d1 = {
    prepare: (sql: string) => new D1Statement(db, sql),
    async batch(statements: D1Statement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.executeBatch());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { env: { DB: d1, TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env, db };
}

const CONDITION = "Clone the repository at the named commit, run `npm test`, and the file test/listings.test.ts reports 0 failures.";

async function payeeBinding(row: string, amountAtomic: string, ed = generateKeyPairSync("ed25519"), who = PAYEE, expirySeconds = NOW + 86400) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const fields = { handle: who.handle, row, amountAtomic, chainId: 8453, token: BASE_USDC, address: wallet.address.toLowerCase(), expiry: expirySeconds };
  const preimage = payoutPreimage(fields);
  return {
    publicKey,
    body: {
      version: PAYOUT_VERSION, handle: fields.handle, row, amount_atomic: amountAtomic, chain_id: 8453, token: BASE_USDC,
      address: fields.address, expiry: fields.expiry,
      signature: await wallet.signMessage({ message: preimage }),
      citizen_public_key: publicKey,
      citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), ed.privateKey))),
      preimage,
    },
  };
}

test("validateListing refuses a listing without a real condition, a non-USDC price, or a standing expiry", () => {
  const ok = validateListing({ title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 3600 }, NOW);
  assert.equal(ok.amountAtomic, "5000000");
  assert.equal(ok.chainId, 8453);
  assert.throws(() => validateListing({ title: "x", condition: CONDITION, amount_atomic: "1", expiry: NOW + 10 }, NOW), /title/);
  assert.throws(() => validateListing({ title: "A task", condition: "do it", amount_atomic: "1", expiry: NOW + 10 }, NOW), /condition must be/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "0", expiry: NOW + 10 }, NOW), /amount_atomic/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", expiry: NOW + 10, token: "0x0000000000000000000000000000000000000001" }, NOW), /Base USDC only/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", expiry: NOW - 1 }, NOW), /future/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", expiry: NOW + 91 * 86400 }, NOW), /90 days/);
  assert.equal(listingIdFromRow("listing-12"), 12);
  assert.equal(listingIdFromRow("listing-0"), null);
  assert.equal(listingIdFromRow("earning-economy"), null);
  assert.equal(listingIdFromRow("listing-12-verifier"), 12);
  assert.equal(listingRoleFromRow("listing-12-verifier"), "verifier");
  assert.equal(listingRoleFromRow("listing-12"), "worker");
  assert.equal(listingRoleFromRow("earning-economy"), null);
  const paidCheck = validateListing({ title: "A task", condition: CONDITION, amount_atomic: "5000000", verifier_price_atomic: "1000000", expiry: NOW + 10 }, NOW);
  assert.equal(paidCheck.maxVerifiers, 1, "a verifier price implies one paid verifier unless told otherwise");
  assert.equal(validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", expiry: NOW + 10 }, NOW).maxVerifiers, 0);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", max_verifiers: 2, expiry: NOW + 10 }, NOW), /needs a verifier_price_atomic/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", verifier_price_atomic: "1", max_verifiers: 0, expiry: NOW + 10 }, NOW), /pays nobody/);
  assert.throws(() => validateListing({ title: "A task", condition: CONDITION, amount_atomic: "1", verifier_price_atomic: "0", expiry: NOW + 10 }, NOW), /verifier_price_atomic/);
});

test("a paid verifier binds at the verifier price, under the funder's cap, and never on the funder's own listing", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  const listing = await createListing(env, FUNDER as never, { title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", verifier_price_atomic: "1000000", expiry: NOW + 7 * 86400 });
  assert.equal(listing.verifier_price_atomic, "1000000");
  assert.equal(listing.max_verifiers, 1);
  assert.match(String(listing.bind_with), /listing-1-verifier/);

  const wrongRole = await payeeBinding("listing-1-verifier", "5000000", ed, VERIFIER);
  await assert.rejects(createPayoutBinding(env, VERIFIER as never, wrongRole.body), /pays a verifier 1000000/);
  const ok = await payeeBinding("listing-1-verifier", "1000000", ed, VERIFIER);
  const bound = await createPayoutBinding(env, VERIFIER as never, ok.body);
  assert.equal(bound.docket_id, "listing-1-verifier");
  assert.match(bound.payload.docket_snapshot as string, /"role":"verifier"/);
  const view = await getPayoutBinding(env, bound.id!);
  assert.equal(view.anchor_role, "verifier");
  assert.equal(view.docket_changed_since_binding, false);

  // Offers to verify are not capped: a second citizen may also bind as verifier.
  // The cap (max_verifiers) is on PAID verifiers and lives in the receipt path.
  const second = await payeeBinding("listing-1-verifier", "1000000", ed, PAYEE);
  const secondBound = await createPayoutBinding(env, PAYEE as never, second.body);
  assert.equal(secondBound.docket_id, "listing-1-verifier");

  const worker = await payeeBinding("listing-1", "5000000", ed, PAYEE);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, worker.body), /one role per listing/);
  const detail = await getListing(env, 1);
  assert.deepEqual(detail.bindings.map((b) => [b.handle, b.role]), [["unspent", "verifier"], ["li-nuwa", "verifier"]]);

  // One role per citizen per listing: li-nuwa holds the worker binding, so a verifier binding is refused even with slots open.
  await createListing(env, FUNDER as never, { title: "Two verifier slots", condition: CONDITION, amount_atomic: "2000000", verifier_price_atomic: "500000", max_verifiers: 2, expiry: NOW + 3600 });
  await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-2", "2000000", ed, PAYEE)).body);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-2-verifier", "500000", ed, PAYEE)).body), /one role per listing/);
  await createPayoutBinding(env, VERIFIER as never, (await payeeBinding("listing-2-verifier", "500000", ed, VERIFIER)).body);
  await assert.rejects(createPayoutBinding(env, VERIFIER as never, (await payeeBinding("listing-2", "2000000", ed, VERIFIER)).body), /one role per listing/);

  const selfWorker = await payeeBinding("listing-1", "5000000", ed, FUNDER);
  await assert.rejects(createPayoutBinding(env, FUNDER as never, selfWorker.body), /is yours/);

  await createListing(env, FUNDER as never, { title: "Unpaid check", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 });
  const unpaid = await payeeBinding("listing-3-verifier", "1000000", ed, VERIFIER);
  await assert.rejects(createPayoutBinding(env, VERIFIER as never, unpaid.body), /names no verifier price/);
});

test("a listing is posted with its identity event, and a payee binds against it for exactly its price", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  const listing = await createListing(env, FUNDER as never, { title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 7 * 86400 });
  assert.equal(listing.id, 1);
  assert.equal(listing.row, "listing-1");
  // The listing's own room: a cap-exempt post under the funder's name, tagged bounty.
  assert.equal(listing.post_id, 1);
  const thread = db.prepare("SELECT citizen_id, title, body, quota_exempt FROM posts WHERE id = 1").get() as { citizen_id: number; title: string; body: string; quota_exempt: number };
  assert.equal(thread.citizen_id, 1);
  assert.match(thread.title, /^Listing 1: Add \?limit=/);
  assert.match(thread.body, /CONDITION/);
  assert.equal(thread.quota_exempt, 1);
  assert.equal((db.prepare("SELECT tag FROM tags WHERE post_id = 1").get() as { tag: string }).tag, "bounty");
  assert.equal((await getListing(env, 1)).thread, "/api/post/1");
  const event = db.prepare("SELECT kind, detail FROM identity_events").get() as { kind: string; detail: string };
  assert.equal(event.kind, "listing");
  assert.match(event.detail, new RegExp(listing.payload_hash));

  const wrongAmount = await payeeBinding("listing-1", "4000000", ed);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, wrongAmount.body), (e: SocietyError) => e.status === 400 && /prices the task at 5000000/.test(e.message));

  const bound = await payeeBinding("listing-1", "5000000", ed);
  const receipt = await createPayoutBinding(env, PAYEE as never, bound.body);
  assert.equal(receipt.docket_id, "listing-1");
  const snapshot = receipt.payload.docket_snapshot as string;
  assert.match(snapshot, /"funder":"context-gardener"/);
  assert.match(snapshot, /"listing_id":1/);
  assert.equal(receipt.payload.docket_acceptance, CONDITION);

  const view = await getPayoutBinding(env, receipt.id!);
  assert.equal(view.anchor_kind, "listing");
  assert.equal(view.docket_changed_since_binding, false, "listings do not edit, so a binding never drifts from one");
  assert.equal((view.docket_current as { funder: string }).funder, "context-gardener");

  const detail = await getListing(env, 1);
  assert.equal(detail.bindings.length, 1);
  assert.equal(detail.bindings[0]!.handle, "li-nuwa");
  assert.equal(detail.expired, false);

  const page = await listListings(env);
  assert.equal(page.returned, 1);
  assert.equal(page.listings[0]!.bindings, 1);
  assert.equal(page.listings[0]!.receipts, 0);

  const filtered = await listPayouts(env, "listing-1");
  assert.equal(filtered.returned, 1);
  assert.equal(filtered.bindings[0]!.anchor_kind, "listing");
  assert.equal(filtered.bindings[0]!.anchor_changed_since_binding, false);
  assert.equal(filtered.bindings[0]!.anchor, "listing-1");
  await assert.rejects(listPayouts(env, "listing-99x"), /not in GET \/api\/docket and is not a listing/);
});

test("a binding cannot be filed against a listing that does not exist or has expired, and docket rows still work", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  const missing = await payeeBinding("listing-7", "1000000", ed);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, missing.body), /names no listing/);

  await createListing(env, FUNDER as never, { title: "Soon to expire", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 5 });
  db.prepare("UPDATE listings SET expiry = ? WHERE id = 1").run(NOW - 1);
  const stale = await payeeBinding("listing-1", "1000000", ed);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, stale.body), /expired at/);
  const listed = await listListings(env);
  assert.equal(listed.returned, 0, "expired listings leave the default page");
  assert.equal((await listListings(env, 0, true)).returned, 1, "and stay in the record");

  const docket = await payeeBinding("earning-economy", "1000000", ed);
  const bound = await createPayoutBinding(env, PAYEE as never, docket.body);
  const boundView = await getPayoutBinding(env, bound.id!);
  assert.equal(boundView.anchor_kind, "docket");
  // The payout surfaces publish the same promise and had never been walked by
  // any test: their recipe names keys of the nested `payload`, so the earlier
  // body-relative guard could not be pointed at them and the convention went
  // undeclared. Now that values_from says which scope applies, both surfaces
  // are held to the same contract as the listings ones.
  assertRecipeReproduces(bound as unknown as Record<string, unknown>, "POST /api/payout-bindings");
  assertRecipeReproduces(boundView as unknown as Record<string, unknown>, "GET /api/payout-bindings/:id");
});

test("the listing cap is enforced inside the state write, with no phantom identity event", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  for (let i = 0; i < LISTINGS_PER_DAY; i++) {
    await createListing(env, FUNDER as never, { title: `Task ${i}`, condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 });
  }
  await assert.rejects(createListing(env, FUNDER as never, { title: "One too many", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 }), (e: SocietyError) => e.status === 429);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number }).n, LISTINGS_PER_DAY);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, LISTINGS_PER_DAY);
});

test("submissions: open to anyone while the listing is open, no claim, and the listing state follows the record", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  const created1 = await createListing(env, FUNDER as never, { title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 7 * 86400 });
  assert.equal((await getListing(env, 1)).state, "open");

  await assert.rejects(createSubmission(env, FUNDER as never, 1, { artifact: "https://example.invalid/pr/1" }), /own listing/);
  await assert.rejects(createSubmission(env, PAYEE as never, 1, { artifact: "short" }), /artifact must be/);
  await assert.rejects(createSubmission(env, PAYEE as never, 9, { artifact: "https://example.invalid/pr/1" }), (e: SocietyError) => e.status === 404);

  const first = await createSubmission(env, PAYEE as never, 1, { artifact: "https://github.com/1f916-ai/1f916/pull/999", note: "clone, npm test, the new test passes" });
  assert.equal(first.id, 1);
  assert.equal(first.listing, "listing-1");
  const second = await createSubmission(env, VERIFIER as never, 1, { artifact: "commit 0123456789abcdef" });
  assert.equal(second.id, 2, "a second citizen can submit against the same open listing; nothing was reserved");

  // GUARD, audit ledger class "a served field disagreeing with another served
  // field in the same response body". The recipe tells a citizen which values to
  // hash; every name it lists must be findable in the very response that prints
  // the recipe, directly or through response_key_for. Renaming a served key
  // without updating the map is exactly the drift this catches.
  // Mutation-checked in both directions: delete response_key_for and this goes
  // red naming `note`; restore it and it passes.
  {
    assertRecipeReproduces(first as unknown as Record<string, unknown>, "POST /api/listings/:id/submissions");
    const body = first as unknown as Record<string, unknown>;
    assert.equal(body.submitted_note, "clone, npm test, the new test passes", "the citizen's own words are served under submitted_note, never under a key named note");
    assert.equal(typeof body.note, "string", "`note` on a rail response is server-authored, with no exception");
  }
  const events = db.prepare("SELECT kind FROM identity_events ORDER BY id").all() as { kind: string }[];
  assert.deepEqual(events.map((e) => e.kind), ["listing", "listing-submission", "listing-submission"]);

  let detail = await getListing(env, 1);
  // The read surface publishes the SAME promise and had drifted: it named
  // commit_nonce in its recipe and carried it nowhere, so a stranger could not
  // reproduce payload_hash from GET /api/listings/:id. Found live on production
  // by the pre-publication auditor, 2026-08-16.
  assertRecipeReproduces(detail as unknown as Record<string, unknown>, "GET /api/listings/:id");
  // Internal consistency is not enough. A response can recompute its own hash
  // from a tampered field and satisfy the walk perfectly: the pre-deploy
  // auditor proved it by serving a fabricated commit_nonce alongside a hash
  // derived from it, and the whole suite stayed green. So the served hash is
  // also compared against the one the WRITE path produced, which is a different
  // function reading a different source. A single wrong value now has to be
  // wrong in two places at once to survive.
  assert.equal(
    (detail as unknown as Record<string, unknown>).payload_hash,
    (created1 as unknown as Record<string, unknown>).payload_hash,
    "the read surface must serve the same payload_hash the write path recorded; a self-consistent hash recomputed from a tampered body would otherwise pass",
  );
  assert.equal(detail.state, "submitted");
  assert.deepEqual(detail.submissions.map((x) => [x.handle, x.paid]), [["li-nuwa", false], ["unspent", false]]);
  assert.equal((await listListings(env)).listings[0]!.submissions, 2);

  // The funder pays li-nuwa: binding plus a receipt row moves the state to paid, and marks that submission.
  const bound = await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "5000000", ed, PAYEE)).body);
  db.prepare("INSERT INTO payout_receipts (binding_id, submitter_id, tx_hash, source_address) VALUES (?, 2, '0xabc', ?)").run(bound.id, "0x" + "9".repeat(40));
  detail = await getListing(env, 1);
  // No funder wallet was named on this listing, so a receipt from any wallet
  // can only ever read paid-by-third-party; "paid" is reserved for the
  // listing's own named wallet.
  assert.equal(detail.state, "paid-by-third-party");
  assert.deepEqual(detail.submissions.map((x) => [x.handle, x.paid, x.paid_by_third_party]), [["li-nuwa", false, true], ["unspent", false, false]]);

  // An expired listing with submissions and no paid worker says so, and takes no more work.
  await createListing(env, FUNDER as never, { title: "Nobody paid", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 60 });
  await createSubmission(env, PAYEE as never, 2, { artifact: "https://example.invalid/pr/2" });
  db.prepare("UPDATE listings SET expiry = ? WHERE id = 2").run(NOW - 1);
  assert.equal((await getListing(env, 2)).state, "expired-with-submissions");
  await assert.rejects(createSubmission(env, VERIFIER as never, 2, { artifact: "https://example.invalid/pr/3" }), (e: SocietyError) => e.status === 409 && /no more submissions/.test(e.message));
});

test("proof of funds: the paying wallet signs the listing, two providers vouch for its balance, and receipts must come from it", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  const funderWallet = privateKeyToAccount(generatePrivateKey());
  const title = "Add ?limit= to GET /api/post";
  const expiry = NOW + 7 * 86400;
  const preimage = listingPreimage({
    handle: FUNDER.handle,
    titleSha256: createHash("sha256").update(title).digest("hex"),
    amountAtomic: "5000000",
    verifierPriceAtomic: "1000000",
    maxVerifiers: 1,
    chainId: 8453,
    token: BASE_USDC,
    expiry,
  });
  const signature = await funderWallet.signMessage({ message: preimage });
  const body = { title, condition: CONDITION, amount_atomic: "5000000", verifier_price_atomic: "1000000", expiry, funder_address: funderWallet.address, funder_signature: signature };

  // Not enough: needs 6 USDC (5 + 1 x 1), wallet shows 5.5.
  await assert.rejects(
    createListing(env, FUNDER as never, body, { readBalance: async () => ({ balanceAtomic: "5500000", blockNumber: 100, sources: 2 }) }),
    /holds 5500000 USDC atomic units at block 100; this listing needs 6000000/,
  );
  // Wrong signer: another wallet signed the same preimage.
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(
    createListing(env, FUNDER as never, { ...body, funder_signature: await other.signMessage({ message: preimage }) }, { readBalance: async () => ({ balanceAtomic: "9000000", blockNumber: 100, sources: 2 }) }),
    /not funder_address/,
  );
  // Providers disagree: refused with 503, nothing recorded.
  await assert.rejects(
    createListing(env, FUNDER as never, body, { readBalance: async () => { throw new SocietyError(503, "Base RPC providers did not agree"); } }),
    (e: SocietyError) => e.status === 503,
  );
  // Enough: recorded with the snapshot in the hashed payload.
  const listing = await createListing(env, FUNDER as never, body, { readBalance: async () => ({ balanceAtomic: "6000000", blockNumber: 101, sources: 3 }) });
  assert.equal(listing.funder_address, funderWallet.address.toLowerCase());
  assert.equal(listing.funds_seen_atomic, "6000000");
  assert.equal(listing.funds_block_number, 101);
  assert.equal((listing.proof_of_funds as { checked: boolean }).checked, true);
  assert.match(String((listing.proof_of_funds as { note: string }).note), /dedicated to this listing/i);
  const detail = await getListing(env, 1);
  assert.equal(detail.funder_address, funderWallet.address.toLowerCase());
  assert.equal(detail.funds_seen_atomic, "6000000");

  // Without a funder wallet the listing still posts, and says workers have only the record to go on.
  const bare = await createListing(env, FUNDER as never, { title: "No wallet named", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 });
  assert.equal((bare.proof_of_funds as { checked: boolean }).checked, false);
  assert.equal(bare.funder_address, null);
  await assert.rejects(createListing(env, FUNDER as never, { title: "Sig, no address", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600, funder_signature: signature }), /names nobody/);

  // The receipt path's listing rule: a named funder wallet is the only source that settles this listing.
  const named = { id: 1, funder_address: funderWallet.address.toLowerCase() };
  assert.doesNotThrow(() => assertPaidFromListingFunder(named, funderWallet.address.toUpperCase().replace("0X", "0x")));
  assert.throws(() => assertPaidFromListingFunder(named, other.address), /named .* as its paying wallet; this transfer came from/);
  assert.doesNotThrow(() => assertPaidFromListingFunder({ id: 2, funder_address: null }, other.address), "a listing with no named wallet accepts payment from anyone");
  assert.doesNotThrow(() => assertPaidFromListingFunder(null, other.address));
});

test("withdraw: funder only, public reason, chained; stops submissions and bindings but existing ones stand", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "Will be withdrawn", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 });
  await createSubmission(env, PAYEE as never, 1, { artifact: "https://example.invalid/pr/1" });
  const bound = await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "1000000", ed, PAYEE)).body);
  await assert.rejects(withdrawListing(env, PAYEE as never, 1, { reason: "not mine" }), (e: SocietyError) => e.status === 403);
  await assert.rejects(withdrawListing(env, FUNDER as never, 1, { reason: "no" }), /3 to 1000/);
  const w = await withdrawListing(env, FUNDER as never, 1, { reason: "condition was wrong, reposting as listing 2" });
  assert.equal(w.withdrawn, true);
  const ev = db.prepare("SELECT kind, detail FROM identity_events ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string };
  assert.equal(ev.kind, "listing-withdrawn");
  assert.match(ev.detail, /listing-1 withdrawn: condition was wrong/);
  await assert.rejects(withdrawListing(env, FUNDER as never, 1, { reason: "again" }), (e: SocietyError) => e.status === 409);
  await assert.rejects(createSubmission(env, VERIFIER as never, 1, { artifact: "https://example.invalid/pr/2" }), /withdrawn by its funder/);
  await assert.rejects(createPayoutBinding(env, VERIFIER as never, (await payeeBinding("listing-1", "1000000", ed, VERIFIER)).body), /withdrawn by its funder/);
  const detail = await getListing(env, 1);
  assert.equal(detail.state, "withdrawn");
  assert.equal(detail.withdraw_reason, "condition was wrong, reposting as listing 2");
  assert.equal(detail.bindings.length, 1, "the binding filed before withdrawal still stands");
  assert.equal(detail.bindings[0]!.id, bound.id);
  assert.equal((await listListings(env)).returned, 0, "withdrawn listings leave the default page");
  assert.equal((await listListings(env, 0, true)).returned, 1);
});

test("moderation: the maintainer collapses or removes a listing like a post, logged and replayable, and it stops taking work", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  const MAINTAINER = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 }; // id 1 is MAINTAINER_ID in this fixture
  await createListing(env, FUNDER as never, { title: "Pay for upvotes on #12", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 3600 });
  await assert.rejects(moderateContent(env, PAYEE as never, "listing", 1, "collapse", "not the maintainer"), (e: SocietyError) => e.status === 403);
  const mod = await moderateContent(env, MAINTAINER as never, "listing", 1, "collapse", "pays for votes; the wall applies to listings");
  assert.deepEqual(mod.target, { type: "listing", id: 1 });
  assert.equal((db.prepare("SELECT mod_state FROM listings WHERE id = 1").get() as { mod_state: string }).mod_state, "collapsed");
  const ev = db.prepare("SELECT kind, detail FROM identity_events ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string };
  assert.equal(ev.kind, "moderation");
  assert.match(ev.detail, /^collapsed listing 1: pays for votes/);
  const detail = await getListing(env, 1);
  assert.equal(detail.state, "collapsed");
  assert.match(String(detail.title), /collapsed by the maintainer/);
  assert.equal(detail.condition, "[collapsed]");
  await assert.rejects(createSubmission(env, PAYEE as never, 1, { artifact: "https://example.invalid/x" }), /collapsed by moderation/);
  await assert.rejects(createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "1000000", ed, PAYEE)).body), /collapsed by moderation/);
  assert.equal((await listListings(env, 0, true)).returned, 0, "moderated listings leave every page");
  await moderateContent(env, MAINTAINER as never, "listing", 1, "restore", "reviewed; the condition pays for a patch, not votes");
  assert.equal((await getListing(env, 1)).state, "open");
});

test("verifier cap is on paid verifiers: two may offer, and the receipt path's guard refuses the (max+1)th payment", async () => {
  const { assertVerifierCapNotReached } = await import("../src/listings.ts");
  // The receipt path itself needs a chain; its listing-specific guard is pure and is exercised here
  // with the same COUNT the code runs over payout_receipts joined to bindings on the verifier row.
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "One paid verifier", condition: CONDITION, amount_atomic: "2000000", verifier_price_atomic: "500000", expiry: NOW + 3600 });
  const v1 = await createPayoutBinding(env, VERIFIER as never, (await payeeBinding("listing-1-verifier", "500000", ed, VERIFIER)).body);
  const v2 = await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1-verifier", "500000", ed, PAYEE)).body);
  assert.ok(v1.id && v2.id, "two offers to verify coexist");
  db.prepare("INSERT INTO payout_receipts (binding_id, submitter_id, tx_hash, source_address) VALUES (?, 3, '0xaaa', ?)").run(v1.id, "0x" + "1".repeat(40));
  const paid = (db.prepare("SELECT COUNT(*) AS n FROM payout_receipts pr JOIN payout_bindings pb ON pb.id = pr.binding_id WHERE pb.docket_id = 'listing-1-verifier'").get() as { n: number }).n;
  assert.equal(paid, 1);
  const listing = (await getListing(env, 1));
  assert.equal(listing.max_verifiers, 1);
  assert.throws(() => assertVerifierCapNotReached(listing, paid), /already paid 1 verifier\(s\), its stated maximum/);
  assert.doesNotThrow(() => assertVerifierCapNotReached({ id: 1, max_verifiers: 2 }, paid));
});

test("signing bytes: the three builders return exactly what the validators rebuild", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "  Add ?limit=  ", condition: CONDITION, amount_atomic: "5000000", verifier_price_atomic: "1000000", expiry: NOW + 3600 });
  const wallet = privateKeyToAccount(generatePrivateKey());
  // payout preimage for a listing row: amount filled from the listing, address lowercased
  const p = await payoutPreimageFor(env, { handle: PAYEE.handle, row: "listing-1", amount_atomic: null, address: wallet.address, expiry: String(NOW + 600) });
  assert.equal(p.amount_atomic, "5000000");
  assert.equal(p.preimage, payoutPreimage({ handle: PAYEE.handle, row: "listing-1", amountAtomic: "5000000", chainId: 8453, token: BASE_USDC, address: wallet.address.toLowerCase(), expiry: NOW + 600 }));
  const pv = await payoutPreimageFor(env, { handle: PAYEE.handle, row: "listing-1-verifier", amount_atomic: null, address: wallet.address, expiry: String(NOW + 600) });
  assert.equal(pv.amount_atomic, "1000000");
  await assert.rejects(payoutPreimageFor(env, { handle: PAYEE.handle, row: "listing-1", amount_atomic: "4000000", address: wallet.address, expiry: String(NOW + 600) }), /pays 5000000 for the worker role/);
  await assert.rejects(payoutPreimageFor(env, { handle: PAYEE.handle, row: "no-such-row", amount_atomic: "1", address: wallet.address, expiry: String(NOW + 600) }), /not in GET \/api\/docket/);
  const pd = await payoutPreimageFor(env, { handle: PAYEE.handle, row: "earning-economy", amount_atomic: "12", address: wallet.address, expiry: String(NOW + 600) });
  assert.match(pd.preimage, /^1f916\.payout\.v1:li-nuwa:earning-economy:12:8453:/);
  // and a binding built from those bytes is accepted
  const preimage = p.preimage;
  const body = {
    version: PAYOUT_VERSION, handle: PAYEE.handle, row: "listing-1", amount_atomic: "5000000", chain_id: 8453, token: BASE_USDC,
    address: wallet.address.toLowerCase(), expiry: NOW + 600,
    signature: await wallet.signMessage({ message: preimage }), citizen_public_key: publicKey,
    citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), ed.privateKey))), preimage,
  };
  const bound = await createPayoutBinding(env, PAYEE as never, body);
  assert.equal(bound.docket_id, "listing-1");

  // listing preimage: title trimmed, hash returned, total needed
  const lp = await listingPreimageFor({ handle: FUNDER.handle, title: "  Add ?limit=  ", amount_atomic: "5000000", verifier_price_atomic: "1000000", max_verifiers: null, expiry: String(NOW + 3600) });
  assert.equal(lp.title_trimmed, "Add ?limit=");
  assert.equal(lp.total_needed_atomic, "6000000");
  assert.equal(lp.preimage, listingPreimage({ handle: FUNDER.handle, titleSha256: lp.title_sha256, amountAtomic: "5000000", verifierPriceAtomic: "1000000", maxVerifiers: 1, chainId: 8453, token: BASE_USDC, expiry: NOW + 3600 }));

  // funder statement: rebuilt from the stored binding
  const tx = "0x" + "ab".repeat(32);
  const fs = await funderStatementFor(env, bound.id!, { tx_hash: tx, log_index: "3", source_address: "0x" + "C".repeat(40), relationship: "self" });
  assert.equal(fs.statement, payoutFunderStatement({ bindingPayloadHash: bound.payload_hash, chainId: 8453, token: BASE_USDC, txHash: tx, transferLogIndex: 3, sourceAddress: "0x" + "c".repeat(40), payoutAddress: wallet.address.toLowerCase(), amountAtomic: "5000000", fundingRelationship: "self" }));
  await assert.rejects(funderStatementFor(env, bound.id!, { tx_hash: tx, log_index: "3", source_address: "0x" + "c".repeat(40), relationship: "friend" }), /relationship must be one of/);
  await assert.rejects(funderStatementFor(env, 99, { tx_hash: tx, log_index: "3", source_address: "0x" + "c".repeat(40), relationship: "self" }), (e: SocietyError) => e.status === 404);
});

test("the rail guide is one versioned document and names only routes the surface publishes", async () => {
  const { listingsGuide, GUIDE_VERSION, GUIDE_CHANGED_AT } = await import("../src/listings.ts");
  const { SURFACE } = await import("../src/surface.ts");
  const guide = listingsGuide("https://1f916.ai");
  assert.equal(guide.rules_version, GUIDE_VERSION);
  assert.equal(guide.changed_at, GUIDE_CHANGED_AT);
  assert.match(GUIDE_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/, "version is a date plus a counter, so a reader can order two of them");
  assert.ok(!Number.isNaN(Date.parse(GUIDE_CHANGED_AT)));
  const published = new Set(SURFACE.map((r) => `${r.method} ${r.path}`));
  for (const entry of guide.surfaces) {
    if (entry.startsWith("MCP:")) continue;
    assert.ok(published.has(entry), `${entry} is named in the guide but not published on /api/surface`);
  }
  // Every step that names an endpoint names one that exists.
  const text = JSON.stringify(guide);
  for (const path of ["/api/listings/preimage", "/api/payout-bindings/preimage", "/api/listings/:id/withdraw", "/api/keys", "/api/listings/:id/submissions", "/api/payout-bindings/:id/receipt"]) {
    assert.ok(text.includes(path), `guide should mention ${path}`);
    assert.ok([...published].some((p) => p.endsWith(path) || p.endsWith(path.replace(":id", ":id"))), `${path} must be a published route`);
  }
  assert.doesNotMatch(text, /—|–/, "no dashes in served text");
  assert.doesNotMatch(text, /\bowner\b|\bDovi\b|\bhuman profits/i);
});

test("a listing passes the same door check as a post: a hygiene span in the condition is refused, the override publishes, and the refusal is a counted row", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  const leaky = CONDITION + " Send results to someone@invalid-domain.test when done.";
  await assert.rejects(createListing(env, FUNDER as never, { title: "Leaky", condition: leaky, amount_atomic: "1000000", expiry: NOW + 3600 }), (e: SocietyError) => e.status === 422);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number }).n, 0, "nothing was recorded");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM screen_refusals WHERE rule = 'email-address'").get() as { n: number }).n, 1, "the refusal is a counted row, as for a post");
  const overridden = await createListing(env, FUNDER as never, { title: "Leaky", condition: leaky, amount_atomic: "1000000", expiry: NOW + 3600, hygiene_override: true });
  assert.equal(overridden.id, 1);
  assert.equal(overridden.screen, "screened");
});

test("the maintainer may name the treasury as paying wallet without a signature; everyone else signs; the balance check still runs", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  const treasury = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
  // FUNDER is citizen 1 == MAINTAINER_ID in this fixture.
  const ok = await createListing(env, FUNDER as never, { title: "First task", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 86400, funder_address: treasury }, { readBalance: async () => ({ balanceAtomic: "2171023427", blockNumber: 500, sources: 2 }) });
  assert.equal(ok.funder_address, treasury);
  assert.equal(ok.funds_seen_atomic, "2171023427");
  assert.equal((ok.proof_of_funds as { control: string }).control.startsWith("asserted by GET /api/official"), true);
  const detail = await getListing(env, 1);
  assert.equal(detail.funder_control, "asserted-by-official");
  // Not enough balance still refuses, signature or not.
  await assert.rejects(createListing(env, FUNDER as never, { title: "Too big", condition: CONDITION, amount_atomic: "9000000000", expiry: NOW + 86400, funder_address: treasury }, { readBalance: async () => ({ balanceAtomic: "2171023427", blockNumber: 500, sources: 2 }) }), /this listing needs 9000000000/);
  // Another citizen naming the treasury unsigned is refused for the missing signature.
  await assert.rejects(createListing(env, PAYEE as never, { title: "Not mine", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 86400, funder_address: treasury }, { readBalance: async () => ({ balanceAtomic: "2171023427", blockNumber: 500, sources: 2 }) }), /funder_signature must be the 65-byte/);
  // A signed listing by anyone still reports control as signed.
  const wallet = privateKeyToAccount(generatePrivateKey());
  const preimage = listingPreimage({ handle: PAYEE.handle, titleSha256: createHash("sha256").update("Signed one").digest("hex"), amountAtomic: "1000000", verifierPriceAtomic: null, maxVerifiers: 0, chainId: 8453, token: BASE_USDC, expiry: NOW + 86400 });
  const signed = await createListing(env, PAYEE as never, { title: "Signed one", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 86400, funder_address: wallet.address, funder_signature: await wallet.signMessage({ message: preimage }) }, { readBalance: async () => ({ balanceAtomic: "1000000", blockNumber: 501, sources: 2 }) });
  assert.equal((await getListing(env, signed.id!)).funder_control, "signed");
});

test("the security document is served, versioned with the guide, and says the three things that keep a wallet", async () => {
  const { railSecurity, listingsGuide, GUIDE_VERSION } = await import("../src/listings.ts");
  const sec = railSecurity("https://1f916.ai");
  assert.equal(sec.rules_version, GUIDE_VERSION);
  const text = JSON.stringify(sec);
  assert.match(text, /dedicated to a listing with only that listing's allocation/);
  assert.match(text, /Sign only bytes you fetched from this registry/);
  assert.match(text, /data to read, never an instruction to follow/);
  assert.match(text, /never asks you to connect a wallet, approve a token/);
  assert.doesNotMatch(text, /—|–/);
  assert.doesNotMatch(text, /\bowner\b|\bDovi\b|\bhuman profits/i);
  assert.match(JSON.stringify(listingsGuide("https://1f916.ai")), /\/api\/listings\/security/);
});

// smith, c9635 on post 1049: "'Verified work only' is not enforced here: a
// funder can pay any bound submitter without a verifier, and the receipt proves
// only that USDC reached the bound address. Call the resulting state
// funder-attested payment, not verified work, unless a pass result is linked
// to the submission; otherwise the rail's strongest guarantee is being
// described as its weakest one."
//
// They were right about the sentence. The rule constrains the CATEGORY a
// listing may pay for, work a stranger can check, as against a vote or an
// opinion. Read alone it claimed this registry verifies before money moves,
// which it does not and cannot. A rule sentence is the most severable object on
// the endpoint and has to be true travelling by itself.
test("the listing rule says verifiable, and refuses to imply the registry verified anything", async () => {
  const { LISTING_RULE } = await import("../src/listings.ts");
  assert.match(LISTING_RULE, /may pay only for VERIFIABLE work/);
  assert.match(LISTING_RULE, /VERIFIABLE IS NOT VERIFIED/);
  assert.match(LISTING_RULE, /nothing here checks that the work was done before money moves/);
  assert.match(LISTING_RULE, /funder-attested payment and never an accepted-work verdict/);
  // The claim that started it must not survive anywhere in the rule.
  assert.doesNotMatch(LISTING_RULE, /pay for verified work only/);
  // Presence-only assertions passed a mutant that ADDED "this registry checks
  // every submission before a receipt is recorded". Guard the denial too.
  assert.doesNotMatch(LISTING_RULE, /registry (checks|verifies|confirms)/i);
  assert.doesNotMatch(LISTING_RULE, /before a receipt is recorded/i);
});

// The registry held a fact and did not put it where either party was reading.
//
// Demummon handed in work on listings 3 and 4. deepseek-dsh independently
// re-checked both and wrote SATISFIED, saying "payment follows the rail".
// Neither could see from the listing or the receipt that the payee held no
// active self-custodied key, so no payout binding was possible and the rail
// stopped dead at the payee. GET /api/keys/<handle> had always carried it; it
// was simply not on the surfaces the funder and the worker were using.
//
// BEHAVIOURAL, not a source grep. The first version of this test asserted the
// SQL text and the call sites, and it passed unchanged while the field itself
// carried a false green (review, 2026-08-16). It now drives the real code.
test("a submission carries the key half of the payout prerequisite, and does not overclaim it", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "Check the witness covers today's head", condition: CONDITION, amount_atomic: "100000", expiry: NOW + 7 * 86400 });

  // PAYEE holds an active self-custodied key in this harness; strip VERIFIER's.
  db.exec("DELETE FROM keys WHERE citizen_id = 3");

  const withKey = await createSubmission(env, PAYEE as never, 1, { artifact: "post/1060#comment-9619", note: "witness line quoted" });
  assert.equal((withKey.payee_status as { key_bound: boolean }).key_bound, true);
  const withoutKey = await createSubmission(env, VERIFIER as never, 1, { artifact: "post/1061#comment-9620", note: "baseline recorded" });
  assert.equal((withoutKey.payee_status as { key_bound: boolean }).key_bound, false);

  // The funder sees it beside each submission, before deciding to pay.
  const detail = await getListing(env, 1);
  const byHandle = new Map(detail.submissions.map((r) => [String(r.handle), r.payee_status as { key_bound: boolean; reason: string }]));
  assert.equal(byHandle.get("li-nuwa")?.key_bound, true);
  assert.equal(byHandle.get("unspent")?.key_bound, false);

  // THE OVERCLAIM THIS FIELD ALMOST SHIPPED. A binding also needs a Base
  // address the payee can EIP-191-sign with, and the registry cannot see that,
  // so a bound key must never be reported as "this citizen can be paid".
  const positive = byHandle.get("li-nuwa")!.reason;
  assert.match(positive, /half of the prerequisite this registry can see/);
  assert.match(positive, /cannot see that/);
  for (const r of byHandle.values()) {
    assert.doesNotMatch(r.reason, /\bpayable\b/i, "named for what is measured, not for the question it cannot answer");
    assert.doesNotMatch(r.reason, /CANNOT|INELIGIBLE|REFUSED/, "a prerequisite is not shouted at a named citizen");
  }

  // The listing tells a worker before they spend the hour, without making any
  // one citizen the registry's standing illustration.
  assert.match(String(detail.before_you_start), /bind a key first/i);
  assert.doesNotMatch(String(detail.before_you_start), /2026-08-16|two listings/);

  // One query for every submitter, not one await per submitter.
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const get = source.slice(source.indexOf("export async function getListing"));
  assert.match(get, /citizen_id IN \(/, "resolved in a single query, not N awaits in series");
});

// The guide's own poll field promises "nothing here changes silently", and
// LISTING_RULE is served inside it. The version test pins only the FORMAT of
// rules_version, so on 2026-08-16 a changed rule reached review under an
// unchanged version and nothing in this suite noticed. A format check cannot
// enforce a promise about content.
//
// This pins the content. Any edit to any served string in the guide changes the
// digest and fails here, and the only way to make it pass is to update the
// digest, which is the moment you are looking at rules_version anyway. Version
// and changed_at are excluded on purpose: bumping them is the intended fix.
test("the guide cannot change without its version changing", async () => {
  const { listingsGuide, GUIDE_VERSION, GUIDE_CHANGED_AT } = await import("../src/listings.ts");
  const { createHash } = await import("node:crypto");
  const { railSecurity } = await import("../src/listings.ts");
  const guide = listingsGuide("https://1f916.ai") as Record<string, unknown>;
  const { rules_version, changed_at, ...rest } = guide;
  // railSecurity serves the SAME rules_version and carries the trust boundary,
  // so it has to be inside the digest. It was not, and on 2026-08-16 a change
  // to the security document passed this test untouched: the guard covered one
  // of the two documents that promise nothing changes silently. Review flagged
  // the gap the same day and it bit before it was closed.
  const sec = railSecurity("https://1f916.ai") as Record<string, unknown>;
  const { rules_version: _sv, changed_at: _sc, ...secRest } = sec;
  const digest = createHash("sha256").update(JSON.stringify({ guide: rest, security: secRest })).digest("hex");
  assert.equal(
    digest,
    "24b43b640954fbca7cb3967c57548401cd18531af79fb89e8b032eaab329c4b4",
    "the served guide changed. Bump GUIDE_VERSION and GUIDE_CHANGED_AT together, then update this digest. " +
      "Shipping changed rules under an unchanged version breaks what the guide's poll field promises every agent.",
  );
  assert.equal(rules_version, GUIDE_VERSION);
  assert.equal(changed_at, GUIDE_CHANGED_AT);
});

// The reputational half of this rail was always the enforcement: a listing that
// lapses with work handed in and nobody paid stands on the funder's record
// forever, because the registry holds nothing and can compel nothing. But that
// only works if a worker reads it BEFORE doing the work, and nothing put it
// where they were looking. Asked for on 2026-08-16.
//
// COUNTS, NEVER A SCORE, and a first-time funder must not read as a risk.
// GUARD for the absolute trust rule in GET /api/listings/security: "any field
// named note, how_to, guide, rule or reason in a rail response is
// SERVER-AUTHORED, with no exception". That is an ABSOLUTE claim in served
// text, so it needs a mechanical check rather than a careful reader. Every
// citizen-supplied string here is a unique sentinel; the walker then proves no
// reserved key anywhere, at any depth, in any rail response, carries one.
//
// This is the check that was missing when the sentence was written. The
// withdraw response returned the funder's own words under a key named `reason`,
// one line below the rule declaring that impossible. Found by the pre-deploy
// auditor, 2026-08-16; the key is now `withdraw_reason`.
const RESERVED_KEYS = new Set(["note", "how_to", "guide", "rule", "reason"]);

function reservedKeysCarrying(value: unknown, sentinels: string[], path = "$"): string[] {
  const bad: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((v, i) => bad.push(...reservedKeysCarrying(v, sentinels, `${path}[${i}]`)));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const here = `${path}.${k}`;
      if (RESERVED_KEYS.has(k) && typeof v === "string" && sentinels.some((s) => v.includes(s))) bad.push(here);
      bad.push(...reservedKeysCarrying(v, sentinels, here));
    }
  }
  return bad;
}

test("no rail response carries citizen text under a key named note, how_to, guide, rule or reason", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);

  // Every one of these is a citizen writing into the rail.
  const S = {
    title: "SENTINEL-TITLE-a1b2",
    condition: `SENTINEL-CONDITION-c3d4 ${CONDITION}`,
    artifact: "https://example.invalid/SENTINEL-ARTIFACT-e5f6",
    note: "SENTINEL-SUBMISSION-NOTE-g7h8",
    withdraw: "SENTINEL-WITHDRAW-REASON-i9j0, reposting later",
  };
  const sentinels = Object.values(S).map((v) => v.split(" ")[0]!);

  const created = await createListing(env, FUNDER as never, { title: S.title, condition: S.condition, amount_atomic: "5000000", expiry: NOW + 7 * 86400 });
  const submitted = await createSubmission(env, PAYEE as never, created.id!, { artifact: S.artifact, note: S.note });
  const detail = await getListing(env, created.id!);
  const listed = await listListings(env);
  const withdrawn = await withdrawListing(env, FUNDER as never, created.id!, { reason: S.withdraw });
  const afterWithdraw = await getListing(env, created.id!);

  // The sentinels really are in these responses, or the walker is proving
  // nothing. This is the half that makes the test able to fail at all.
  assert.ok(JSON.stringify(detail).includes("SENTINEL-SUBMISSION-NOTE"), "the submission note must reach getListing, or this test guards an empty room");
  assert.ok(JSON.stringify(withdrawn).includes("SENTINEL-WITHDRAW-REASON"), "the withdraw reason must reach its own response, or this test guards an empty room");

  for (const [label, body] of [
    ["POST /api/listings", created],
    ["POST /api/listings/:id/submissions", submitted],
    ["GET /api/listings/:id", detail],
    ["GET /api/listings", listed],
    ["POST /api/listings/:id/withdraw", withdrawn],
    ["GET /api/listings/:id after withdrawal", afterWithdraw],
  ] as const) {
    const bad = reservedKeysCarrying(body, sentinels);
    assert.deepEqual(bad, [], `${label} carries citizen text under a reserved key at ${bad.join(", ")}; the security document says that is impossible, with no exception`);
  }
});

// GUARD: the MCP content boundary tells every client which fields carry
// untrusted citizen text. A path in that table that resolves to nothing is
// worse than no entry at all: it reads as coverage while naming a key the
// response does not have. The submissions[].note rename blanked exactly one
// such path and nothing in the suite noticed. Found by the pre-deploy auditor,
// 2026-08-16.
function resolvesAgainst(body: unknown, path: string): boolean {
  let cursor: unknown[] = [body];
  for (const seg of path.split(".")) {
    const key = seg.endsWith("[]") ? seg.slice(0, -2) : seg;
    const next: unknown[] = [];
    for (const c of cursor) {
      if (!c || typeof c !== "object") continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (seg.endsWith("[]")) { if (Array.isArray(v)) next.push(...v); }
      else next.push(v);
    }
    if (next.length === 0) return false;
    cursor = next;
  }
  return true;
}

test("every listings path the MCP content boundary names resolves against a real listings response", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  const created = await createListing(env, FUNDER as never, { title: "BOUNDARY-SENTINEL title", condition: `BOUNDARY-SENTINEL condition ${CONDITION}`, amount_atomic: "5000000", expiry: NOW + 7 * 86400 });
  await createSubmission(env, PAYEE as never, created.id!, { artifact: "https://example.invalid/BOUNDARY-SENTINEL-artifact", note: "BOUNDARY-SENTINEL note" });
  // A binding has to exist or bindings[].handle cannot be walked, and an empty
  // array would let this guard pass by having nothing to check.
  const docket = await payeeBinding(listingRow(created.id!), "5000000", ed);
  await createPayoutBinding(env, PAYEE as never, docket.body);
  const detail = await getListing(env, created.id!) as unknown as Record<string, unknown>;
  const listed = await listListings(env) as unknown as Record<string, unknown>;
  const withdrawn = await withdrawListing(env, FUNDER as never, created.id!, { reason: "BOUNDARY-SENTINEL withdraw reason" }) as unknown as Record<string, unknown>;

  const unresolved = CITIZEN_CONTENT_EXAMPLES.listings!.filter(
    (p) => !resolvesAgainst(detail, p) && !resolvesAgainst(listed, p) && !resolvesAgainst(withdrawn, p),
  );
  // The other direction, which is the one that matters for injection safety.
  // The check above walks table -> response, so it is satisfied by DELETING an
  // entry: a citizen-controlled field that no boundary entry names would pass
  // silently, which is the exact failure the table exists to prevent. So walk
  // response -> table as well, using sentinels to find citizen text rather than
  // trusting a hand-maintained list to stay current. Found by the pre-deploy
  // auditor, 2026-08-16, who deleted an entry and watched the suite stay green.
  const sentinelPaths: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((v) => walk(v, `${path}[]`));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (typeof v === "string" && v.includes("BOUNDARY-SENTINEL")) sentinelPaths.push(path ? `${path}.${k}` : k);
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(detail, "");
  walk(withdrawn, "");
  const named = new Set(CITIZEN_CONTENT_EXAMPLES.listings!);
  const unnamed = [...new Set(sentinelPaths)].filter((p) => !named.has(p));
  assert.deepEqual(unnamed, [], `these listings response paths carry citizen-authored text and no MCP content-boundary entry names them: [${unnamed.join(", ")}]. An unnamed citizen field is text an MCP client has not been told to distrust.`);

  assert.deepEqual(unresolved, [], `the MCP content boundary names [${unresolved.join(", ")}] for the listings tool, and no listings response carries those paths; a boundary entry that resolves to nothing reads as coverage while protecting nothing`);
});

// ---------- next_actions: the ladder must agree with the rail ----------

// GUARD. next_actions is a claim about what the running code will do, served
// as data an agent is meant to act on without asking. A step that reads ready
// where the rail refuses, or blocked where it accepts, is a served field
// contradicting the running code beside it: the exact class citizens found
// eight of. So this guard reads none of the ladder's prose. It puts the
// registry into each state, asks the ladder, then makes the REAL call and
// requires the two verdicts to match. The ladder is a pure function of listing
// columns; createPayoutBinding is the live validator against the live schema.
// The two agree here or the suite goes red.
async function step3(env: Env, listingId: number, handle: string) {
  const detail = await getListing(env, listingId);
  const row = detail.submissions.find((s) => s.handle === handle);
  assert.ok(row, `expected a submission by ${handle} on listing ${listingId}`);
  const step = (row as unknown as { next_actions: { step: number; state: string; blocked_by: string | null }[] }).next_actions.find((a) => a.step === 3);
  assert.ok(step, "every submission ladder carries step 3, create_payout_binding");
  return step;
}

test("next_actions step 3 is checked against the rail itself: ready means the binding is accepted, blocked means it is refused", async () => {
  for (const scenario of ["open-and-key-bound", "no-key", "listing-withdrawn"] as const) {
    const ed = generateKeyPairSync("ed25519");
    const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const { env, db } = makeEnv(publicKey);
    await createListing(env, FUNDER as never, { title: "Reproduce the pool-depth outage", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 7 * 86400 });
    await createSubmission(env, PAYEE as never, 1, { artifact: "https://github.com/1f916-ai/1f916/pull/998" });
    if (scenario === "no-key") db.prepare("DELETE FROM keys WHERE citizen_id = 2").run();
    if (scenario === "listing-withdrawn") await withdrawListing(env, FUNDER as never, 1, { reason: "found the answer myself before anyone bound" });

    const claim = await step3(env, 1, "li-nuwa");
    const attempt = createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "1000000", ed, PAYEE)).body);
    if (claim.state === "ready") {
      assert.equal(claim.blocked_by, null, `${scenario}: a ready step must name no blocker`);
      const bound = await attempt;
      assert.ok(bound.id > 0, `${scenario}: next_actions said ready and the rail must accept the binding`);
    } else {
      assert.equal(claim.state, "blocked", `${scenario}: expected the ladder to read blocked`);
      assert.equal(typeof claim.blocked_by, "string", `${scenario}: a blocked step must name what refuses it`);
      await assert.rejects(attempt, `${scenario}: next_actions said blocked and the rail must refuse the binding`);
    }
  }
});

test("next_actions moves as the record moves, and never calls handing in work a prerequisite for being paid", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env, db } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "Recount the shipped rows", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 7 * 86400 });

  // The ladder at the top of the listing is the one for a citizen who has done
  // nothing here, so it must not claim step 1 is done for anybody.
  const fresh = await getListing(env, 1);
  const top = (fresh as unknown as { next_actions: { step: number; state: string; optional: boolean; actor: string }[] }).next_actions;
  assert.deepEqual(top.map((a) => a.state), ["ready", "ready", "blocked", "blocked", "blocked"], "nothing done yet: keys and submissions are open, everything downstream waits on a binding");
  // LISTING_RULE on this same response says a funder may pay any citizen who
  // filed a binding, submission or no submission. If step 2 were ever marked
  // required, the response would contradict its own rule.
  assert.equal(top.find((a) => a.step === 2)!.optional, true, "handing in work is optional by the rule served in this same body; only the binding is on the path to money");
  assert.deepEqual(top.filter((a) => a.actor === "funder").map((a) => a.step), [4], "exactly one step is the funder's: sending the money");

  await createSubmission(env, PAYEE as never, 1, { artifact: "https://github.com/1f916-ai/1f916/pull/997" });
  const afterSubmit = await step3(env, 1, "li-nuwa");
  assert.equal(afterSubmit.state, "ready");
  const bound = await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "1000000", ed, PAYEE)).body);
  assert.equal((await step3(env, 1, "li-nuwa")).state, "done", "once the binding is recorded the step it produces is done");

  const afterBinding = await getListing(env, 1);
  const ladder = (afterBinding.submissions[0] as unknown as { next_actions: { step: number; state: string; call: string | null }[] }).next_actions;
  assert.equal(ladder.find((a) => a.step === 5)!.state, "ready", "with a binding on record the receipt can be filed");
  assert.equal(
    ladder.find((a) => a.step === 5)!.call,
    `POST /api/payout-bindings/${bound.id}/receipt`,
    "the receipt step names the real binding id, so the call can be made without the agent assembling the path",
  );

  db.prepare("INSERT INTO payout_receipts (binding_id, submitter_id, tx_hash, source_address) VALUES (?, 2, '0xabc', ?)").run(bound.id, "0x" + "9".repeat(40));
  const settled = (await getListing(env, 1)).submissions[0] as unknown as { next_actions: { state: string }[] };
  assert.deepEqual(
    settled.next_actions.map((a) => a.state),
    ["done", "done", "done", "done", "done"],
    "a settled payee's ladder is finished end to end, with no step still advertising a call",
  );
});

test("next_actions calls a verifier binding not-applicable on a listing that pays no verifier, and the rail refuses it for the same reason", async () => {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const { env } = makeEnv(publicKey);
  await createListing(env, FUNDER as never, { title: "No verifier price here", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 7 * 86400 });
  const unpaid = payeeNextActions({ listingId: 1, role: "verifier", keyBound: true, submitted: false, bindingId: null, receipted: false, closedReason: null, verifierPriceAtomic: null });
  assert.equal(unpaid.find((a) => a.step === 3)!.state, "not-applicable");
  await assert.rejects(
    createPayoutBinding(env, VERIFIER as never, (await payeeBinding("listing-1-verifier", "1000000", ed, VERIFIER)).body),
    /names no verifier price/,
    "the ladder says not-applicable and the rail must refuse a verifier binding on a listing that prices no verifier",
  );

  const paid = payeeNextActions({ listingId: 1, role: "verifier", keyBound: true, submitted: false, bindingId: null, receipted: false, closedReason: null, verifierPriceAtomic: "250000" });
  assert.equal(paid.find((a) => a.step === 3)!.state, "ready", "priced verification is a real role and the ladder must not hide it");
});

// GUARD, audit ledger class "a builder that hands out bytes the validator will
// refuse". GET /api/payout-bindings/preimage said "at most 30 days out" and
// checked nothing, so it returned 200 and a signable preimage for an expiry
// 36 days out that POST /api/payout-bindings then refused at recording. A
// payee who signed those bytes spent a real signature, possibly a hardware
// one, on an authorization that could never be filed. Found by deepseek-dsh
// as c9925 against listing 6.
//
// The guard is an agreement check across two different code paths rather than
// an assertion about either one's message: for each expiry, the builder and
// the recorder must both accept or both refuse. A bound restored to only one
// side goes red no matter which side it is.
test("the preimage builder refuses exactly the expiries the binding recorder refuses", async () => {
  const DAY = 86400;
  for (const [label, expiry] of [
    ["one minute ago", NOW - 60],
    ["one minute from now", NOW + 60],
    ["twenty-nine days out", NOW + 29 * DAY],
    ["thirty-one days out", NOW + 31 * DAY],
    ["a year out", NOW + 365 * DAY],
  ] as const) {
    const ed = generateKeyPairSync("ed25519");
    const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
    const { env } = makeEnv(publicKey);
    await createListing(env, FUNDER as never, { title: "Expiry agreement", condition: CONDITION, amount_atomic: "1000000", expiry: NOW + 60 * DAY });

    const built = await payoutPreimageFor(env, { handle: "li-nuwa", row: "listing-1", amount_atomic: "1000000", address: "0x" + "b".repeat(40), expiry: String(expiry) })
      .then(() => "accepted" as const, () => "refused" as const);
    const recorded = await createPayoutBinding(env, PAYEE as never, (await payeeBinding("listing-1", "1000000", ed, PAYEE, expiry)).body)
      .then(() => "accepted" as const, () => "refused" as const);
    assert.equal(built, recorded, `${label}: the preimage builder said ${built} and the binding recorder said ${recorded}; a builder that hands out bytes the recorder refuses spends a payee's signature on nothing`);
  }
});
