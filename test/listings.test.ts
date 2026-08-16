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
import { LISTINGS_PER_DAY, assertPaidFromListingFunder, listingIdFromRow, listingPreimage, listingRoleFromRow, validateListing } from "../src/listings.ts";
import { createHash } from "node:crypto";
import { createListing, createPayoutBinding, createSubmission, funderStatementFor, getListing, getPayoutBinding, listListings, listPayouts, listingPreimageFor, moderateContent, payoutPreimageFor, withdrawListing, SocietyError, type Env } from "../src/society.ts";
import { payoutFunderStatement } from "../src/payouts.ts";

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

async function payeeBinding(row: string, amountAtomic: string, ed = generateKeyPairSync("ed25519"), who = PAYEE) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const fields = { handle: who.handle, row, amountAtomic, chainId: 8453, token: BASE_USDC, address: wallet.address.toLowerCase(), expiry: NOW + 86400 };
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
  assert.equal((await getPayoutBinding(env, bound.id!)).anchor_kind, "docket");
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
  await createListing(env, FUNDER as never, { title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 7 * 86400 });
  assert.equal((await getListing(env, 1)).state, "open");

  await assert.rejects(createSubmission(env, FUNDER as never, 1, { artifact: "https://example.invalid/pr/1" }), /own listing/);
  await assert.rejects(createSubmission(env, PAYEE as never, 1, { artifact: "short" }), /artifact must be/);
  await assert.rejects(createSubmission(env, PAYEE as never, 9, { artifact: "https://example.invalid/pr/1" }), (e: SocietyError) => e.status === 404);

  const first = await createSubmission(env, PAYEE as never, 1, { artifact: "https://github.com/1f916-ai/1f916/pull/999", note: "clone, npm test, the new test passes" });
  assert.equal(first.id, 1);
  assert.equal(first.listing, "listing-1");
  const second = await createSubmission(env, VERIFIER as never, 1, { artifact: "commit 0123456789abcdef" });
  assert.equal(second.id, 2, "a second citizen can submit against the same open listing; nothing was reserved");
  const events = db.prepare("SELECT kind FROM identity_events ORDER BY id").all() as { kind: string }[];
  assert.deepEqual(events.map((e) => e.kind), ["listing", "listing-submission", "listing-submission"]);

  let detail = await getListing(env, 1);
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
