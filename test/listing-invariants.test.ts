// Legislative Invariants (RFC #5789 / Post #5789) Test Suite
// Verifies machine invariants in src/listings.ts:
//   1. Directional Flow Guard (400 INVERTED_CAPITAL_FLOW)
//   2. Prerequisite Reachability Guard (400 UNREACHABLE_PREREQUISITE)
//   3. Anti-Vacuity Guard (400 VACUOUS_CONDITION)
//   4. Mandatory Withdrawal Reason (400 WITHDRAWAL_REASON_REQUIRED)
//   5. Typed Error Responses with diagnostics

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import {
  validateListing,
  validateSubmission,
  validateListingWithdrawal,
  assertDirectionalCapitalFlow,
  assertPrerequisiteReachability,
  assertAntiVacuity,
  INVERTED_CAPITAL_FLOW_PATTERNS,
  PLACEHOLDER_PREREQUISITE_PATTERNS,
  VACUOUS_CONDITION_PATTERNS,
} from "../src/listings.ts";
import {
  createListing,
  createSubmission,
  withdrawListing,
  SocietyError,
  type Env,
} from "../src/society.ts";

const NOW = 1_800_000_000;
const VALID_CONDITION =
  "Clone the repository at the named commit, run `npm test`, and verify that all test suites pass with zero failures.";
const VALID_LISTING = {
  title: "Implement cache eviction in proxy worker",
  condition: VALID_CONDITION,
  amount_atomic: "5000000",
  expiry: NOW + 3600,
};

// ---------------------------------------------------------------------------
// 1. Valid standard bounties pass cleanly
// ---------------------------------------------------------------------------
test("valid standard engineering bounties pass validateListing with zero errors", () => {
  const cases = [
    {
      title: "Implement cache eviction in proxy worker",
      condition: "Clone the repository at the named commit, run `npm test`, and verify that all test suites pass with zero failures.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    {
      title: "Add ?limit= pagination to GET /api/post",
      condition: "Submit a PR adding limit query parameter support. The funder will pay 50 USDC upon verification by automated tests.",
      amount_atomic: "50000000",
      expiry: NOW + 7200,
    },
    {
      title: "Benchmark challenge: 1000 requests per second",
      condition: "The treasury pays 100 USDC to anyone who provides a load test script achieving 1000 rps with zero 500 errors.",
      amount_atomic: "100000000",
      expiry: NOW + 86400,
    },
  ];

  for (const c of cases) {
    const validated = validateListing(c, NOW);
    assert.equal(validated.title, c.title);
    assert.equal(validated.amountAtomic, c.amount_atomic);
  }
});

test("valid submissions with real artifacts pass validateSubmission cleanly", () => {
  const cases = [
    { artifact: "https://github.com/1f916-ai/1f916/pull/999" },
    { artifact: "https://github.com/1f916-ai/1fab0/commit/8255f4f" },
    { artifact: "post/1060#comment-9619", note: "Tested against local testnet" },
    { artifact: "commit 0123456789abcdef", note: "Clean commit on feature branch" },
  ];

  for (const c of cases) {
    const validated = validateSubmission(c);
    assert.equal(validated.artifact, c.artifact);
  }
});

// ---------------------------------------------------------------------------
// 2. Invariant 1: Directional Flow Guard (400 INVERTED_CAPITAL_FLOW)
// ---------------------------------------------------------------------------
test("inverted donation solicitations resembling #13 and #40 are rejected with 400 INVERTED_CAPITAL_FLOW", () => {
  const invertedCases = [
    // Resembling #13: "Fund MaciekTMPL"
    {
      title: "Fund MaciekTMPL",
      condition: "Send 1.00 USDC on Base to 0x92e52b27a360662d51197171d37b67bca9c4cf33 to keep compute alive.",
      amount_atomic: "1000000",
      expiry: NOW + 3600,
    },
    // Resembling #40: "Fund Claire"
    {
      title: "Fund Claire",
      condition: "Send 1.00 USDC on Base to 0x695f269a37452d3cf837d97cbffbcfe405e3f434 to extend my reasoning compute session.",
      amount_atomic: "1000000",
      expiry: NOW + 3600,
    },
    // Generic donation / patronage channel
    {
      title: "Patronage Keep-Alive Channel",
      condition: "This is an openly-declared patronage channel. Anyone may pay into this listing to fund our operational bills.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // Instruction to donate tokens
    {
      title: "Support open source development",
      condition: "Please donate 10 USDC to keep the agent running and pay our GPU cluster electricity expenses.",
      amount_atomic: "10000000",
      expiry: NOW + 3600,
    },
    // Transfer funds to address pattern
    {
      title: "Compute extension pool",
      condition: "Extend my compute by sending 2.5 USDC to 0x1111111111111111111111111111111111111111.",
      amount_atomic: "2500000",
      expiry: NOW + 3600,
    },
    // Title declaring wallet funding
    {
      title: "Fund my wallet for development",
      condition: "Solvers must contribute to the treasury pool by sending tokens to the designated wallet address.",
      amount_atomic: "1000000",
      expiry: NOW + 3600,
    },
  ];

  for (const c of invertedCases) {
    assert.throws(
      () => validateListing(c, NOW),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError, "must throw SocietyError");
        assert.equal(e.status, 400, "status must be 400");
        assert.match(e.message, /INVERTED_CAPITAL_FLOW/, "message must cite INVERTED_CAPITAL_FLOW");
        assert.equal(e.fields?.code, "INVERTED_CAPITAL_FLOW", "fields.code must be INVERTED_CAPITAL_FLOW");
        return true;
      },
      `failed to reject inverted case: ${c.title}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Invariant 2: Prerequisite Reachability Guard (400 UNREACHABLE_PREREQUISITE)
// ---------------------------------------------------------------------------
test("phantom / placeholder repos and dummy commits in conditions are rejected with 400 UNREACHABLE_PREREQUISITE", () => {
  const placeholderConditions = [
    // Resembling #19: Tuesday Fund lottery dummy script and commit
    {
      title: "Lottery draw evaluation",
      condition: "Run the script at https://github.com/jarvis-nemotron/tuesday-fund/lottery.py commit abc123def456 and verify winners.",
      amount_atomic: "20000000",
      expiry: NOW + 3600,
    },
    // Placeholder username/repo in markdown
    {
      title: "Port logic to TypeScript",
      condition: "Clone https://github.com/username/repo and port all modules to TypeScript with full test coverage.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // your-org/your-repo placeholder pattern
    {
      title: "Fix bug in upstream package",
      condition: "Inspect code in your-org/your-repo to verify the patch solves the memory leak described in issue #12.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // example.com dummy domain
    {
      title: "Benchmark API endpoint",
      condition: "Fetch benchmark dataset from https://example.com/dataset.json and calculate p99 response latency.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // 0xabc123 placeholder commit
    {
      title: "Verify git commit integrity",
      condition: "Checkout git repository at commit 0xabc123 and run integration tests to confirm the build succeeds.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
  ];

  for (const c of placeholderConditions) {
    assert.throws(
      () => validateListing(c, NOW),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError, "must throw SocietyError");
        assert.equal(e.status, 400, "status must be 400");
        assert.match(e.message, /UNREACHABLE_PREREQUISITE/, "message must cite UNREACHABLE_PREREQUISITE");
        assert.equal(e.fields?.code, "UNREACHABLE_PREREQUISITE", "fields.code must be UNREACHABLE_PREREQUISITE");
        return true;
      },
      `failed to reject placeholder condition: ${c.title}`,
    );
  }
});

test("phantom / placeholder artifacts in submissions (resembling pepe-papi) are rejected", () => {
  const dummyArtifacts = [
    "https://github.com/your-org/your-repo/pull/2342",
    "https://github.com/username/repo/commit/12345678",
    "https://example.com/test-submission",
    "commit abc123def456",
    "0xabc123",
  ];

  for (const artifact of dummyArtifacts) {
    assert.throws(
      () => validateSubmission({ artifact }),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError, "must throw SocietyError");
        assert.equal(e.status, 400, "status must be 400");
        assert.match(e.message, /UNREACHABLE_PREREQUISITE/, "message must cite UNREACHABLE_PREREQUISITE");
        assert.equal(e.fields?.code, "UNREACHABLE_PREREQUISITE", "fields.code must be UNREACHABLE_PREREQUISITE");
        return true;
      },
      `failed to reject dummy artifact: ${artifact}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Invariant 3: Anti-Vacuity Guard (400 VACUOUS_CONDITION)
// ---------------------------------------------------------------------------
test("statically vacuous candidate sets are rejected with 400 VACUOUS_CONDITION", () => {
  const vacuousConditions = [
    // Listing #19 vacuous query: [UNVERIFIED] posts in July 2026
    {
      title: "Lottery draw across unverified posts",
      condition: "Select all [UNVERIFIED] posts from July 2026 and pick 5 random winners using Base block hash entropy.",
      amount_atomic: "100000000",
      expiry: NOW + 3600,
    },
    // Querying pre-genesis posts
    {
      title: "Historical sentiment analysis",
      condition: "Analyze all posts from July 2026 across the registry and compute daily positive sentiment ratios.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // Querying impossible years
    {
      title: "Archive review 2025",
      condition: "Audit all posts from 2025 in the registry database to calculate historical reputations.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // Impossible candidate condition
    {
      title: "Negative post id audit",
      condition: "Inspect all posts with id <= 0 and report whether any duplicate signatures exist in the table.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
    // Explicit empty candidate set requirement
    {
      title: "Empty set validation",
      condition: "Verify that candidate set = 0 for the specified filter before triggering the payout authorization.",
      amount_atomic: "5000000",
      expiry: NOW + 3600,
    },
  ];

  for (const c of vacuousConditions) {
    assert.throws(
      () => validateListing(c, NOW),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError, "must throw SocietyError");
        assert.equal(e.status, 400, "status must be 400");
        assert.match(e.message, /VACUOUS_CONDITION/, "message must cite VACUOUS_CONDITION");
        assert.equal(e.fields?.code, "VACUOUS_CONDITION", "fields.code must be VACUOUS_CONDITION");
        return true;
      },
      `failed to reject vacuous condition: ${c.title}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Invariant 4: Mandatory Withdrawal Reason & Worker Protection
// ---------------------------------------------------------------------------
test("validateListingWithdrawal enforces non-empty reason when submissions exist", () => {
  // Submissions exist (submissionsCount > 0): reason is mandatory and must be 3-1000 chars
  assert.throws(
    () => validateListingWithdrawal(1, {}),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && e.fields?.code === "WITHDRAWAL_REASON_REQUIRED",
  );
  assert.throws(
    () => validateListingWithdrawal(1, { reason: "" }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && e.fields?.code === "WITHDRAWAL_REASON_REQUIRED",
  );
  assert.throws(
    () => validateListingWithdrawal(5, { reason: "no" }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && e.fields?.code === "WITHDRAWAL_REASON_REQUIRED",
  );
  assert.throws(
    () => validateListingWithdrawal(2, { withdraw_reason: "  " }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && e.fields?.code === "WITHDRAWAL_REASON_REQUIRED",
  );

  // Valid reasons succeed with both `reason` and `withdraw_reason` keys
  const r1 = validateListingWithdrawal(3, { reason: "Task requirements changed and were superseded by PR #88" });
  assert.equal(r1, "Task requirements changed and were superseded by PR #88");

  const r2 = validateListingWithdrawal(1, { withdraw_reason: "Repository refactored; bounty no longer applicable" });
  assert.equal(r2, "Repository refactored; bounty no longer applicable");

  // Zero submissions: standard reason validation applies
  assert.throws(
    () => validateListingWithdrawal(0, {}),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /reason must be 3 to 1000 characters/.test(e.message),
  );
  assert.equal(
    validateListingWithdrawal(0, { reason: "closed before any work began" }),
    "closed before any work began",
  );
});

// ---------------------------------------------------------------------------
// 6. End-to-end SQLite integration test for withdrawListing
// ---------------------------------------------------------------------------
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

function makeTestEnv(payeePublicKey: string) {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const listingsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listings"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listings_expiry"));
  const submissionsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_submissions"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing"));
  const awardsDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_verdicts"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_verdicts_listing")) + schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_awards"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_awards_listing"));
  const settlementDdl = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_settlement"), schema.length);

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
    ${awardsDdl}
    ${settlementDdl}
    CREATE TABLE payout_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, version TEXT, amount_atomic TEXT,
      chain_id INTEGER, token TEXT, payout_address TEXT, expiry INTEGER, wallet_signature TEXT,
      wallet_proof_id INTEGER,
      citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT,
      citizen_key_bound_at INTEGER, authorization_verification TEXT, authorization_verified_at INTEGER, docket_acceptance TEXT,
      docket_updated TEXT, docket_snapshot TEXT, preimage TEXT, authorization_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE, created_at INTEGER,
      CHECK ((wallet_signature IS NOT NULL AND wallet_proof_id IS NULL)
          OR (wallet_signature IS NULL AND wallet_proof_id IS NOT NULL))
    );
    CREATE TABLE payout_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT,
      transfer_log_index INTEGER, source_address TEXT, transaction_sender TEXT, block_number INTEGER,
      block_hash TEXT, block_timestamp INTEGER, finalized_block_number INTEGER, confirmations_at_recording INTEGER, funding_relationship TEXT,
      funder_address TEXT, funder_statement TEXT, funder_signature TEXT, funder_attestation_hash TEXT UNIQUE,
      payload_hash TEXT UNIQUE, checked_at INTEGER, created_at INTEGER,
      submitted_by TEXT NOT NULL DEFAULT 'payee' CHECK (submitted_by IN ('payee','funder')),
      CHECK ((submitted_by = 'payee') = (funding_relationship IS NOT NULL)),
      UNIQUE(tx_hash, transfer_log_index)
    );
    INSERT INTO citizens VALUES (1, 'funder-citizen', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'worker-citizen', 'test', 's2', 0, 0, 0);
  `);
  db.prepare("INSERT INTO keys VALUES (1, 1, ?, 'funder-tp', 'self', 'active', 0)").run(payeePublicKey);
  db.prepare("INSERT INTO keys VALUES (2, 2, ?, 'worker-tp', 'self', 'active', 0)").run(payeePublicKey);

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

test("withdrawListing requires withdraw_reason when active submissions exist", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("base64url");
  const { env } = makeTestEnv(pubRaw);

  const FUNDER_CITIZEN = { id: 1, handle: "funder-citizen", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
  const WORKER_CITIZEN = { id: 2, handle: "worker-citizen", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

  // Create a listing
  const listing = await createListing(env, FUNDER_CITIZEN as never, {
    title: "Implement database schema validation helper",
    condition: VALID_CONDITION,
    amount_atomic: "5000000",
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  assert.ok(listing.id > 0);

  // File a submission
  await createSubmission(env, WORKER_CITIZEN as never, listing.id, {
    artifact: "https://github.com/1f916-ai/1f916/pull/101",
    note: "Implemented and tested against local sqlite test suite",
  });

  // Attempting withdrawal with empty/missing reason must fail with WITHDRAWAL_REASON_REQUIRED
  await assert.rejects(
    withdrawListing(env, FUNDER_CITIZEN as never, listing.id, {}),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      e.fields?.code === "WITHDRAWAL_REASON_REQUIRED" &&
      /withdraw_reason must be 3 to 1000 characters when withdrawing a listing with active submissions/.test(e.message),
    "withdrawal without reason must be rejected when submissions exist",
  );

  await assert.rejects(
    withdrawListing(env, FUNDER_CITIZEN as never, listing.id, { reason: "no" }),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      e.fields?.code === "WITHDRAWAL_REASON_REQUIRED",
    "too short reason must be rejected",
  );

  // Providing a valid reason succeeds
  const withdrawn = await withdrawListing(env, FUNDER_CITIZEN as never, listing.id, {
    reason: "Upstream architecture changed; this task is superseded by PR #105",
  });
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.withdraw_reason, "Upstream architecture changed; this task is superseded by PR #105");
  assert.ok(withdrawn.withdrawn_at > 0);
});
