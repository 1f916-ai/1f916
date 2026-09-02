import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_USDC, PAYOUT_BINDING_HASH_FIELDS, PAYOUT_RECEIPT_HASH_FIELDS, PAYOUT_VERSION, matchTransfer, payoutFunderStatement, payoutPreimage, validatePayoutBinding, validateReceiptInput, verifyBasePayment, verifyFunderAttestation } from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { DOCKET } from "../src/docket.ts";
import { createPayoutBinding, createPayoutReceipt, getPayoutBinding, listPayouts, SocietyError, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(result.changes) } };
  }
  executeBatch() {
    const statement = this.db.prepare(this.sql);
    let results: unknown[] = [];
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT\b/i.test(this.sql)) results = statement.all(...(this.args as never[]));
    else statement.run(...(this.args as never[]));
    const changes = Number((this.db.prepare("SELECT changes() AS n").get() as { n: number }).n);
    return { results, meta: { changes } };
  }
}

function makeEnv(publicKey: string, status = "active", citizenId = 1) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE keys (citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER)");
  // Present but empty by default, so omitting the wallet signature resolves to
  // "no live proof" (a 400 a caller can act on) rather than a missing-table
  // crash. Tests that want proof mode insert a row themselves.
  db.exec("CREATE TABLE payout_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, version TEXT, chain_id INTEGER, address TEXT, expiry INTEGER, wallet_signature TEXT, citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT, citizen_key_bound_at INTEGER, preimage TEXT, proof_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE, created_at INTEGER, revoked_at INTEGER, revoke_reason TEXT)");
  db.prepare("INSERT INTO keys VALUES (?, ?, 'citizen-tp', 'self', ?, 0)").run(citizenId, publicKey, status);
  return { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env;
}

const CITIZEN = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
// A live clock, not a pinned one: createPayoutBinding reads Date.now(), so a
// fixed NOW made every binding fixture expire one day after the PR was written
// (the suite went red at 2026-08-14T15:13Z with nothing changed).
const NOW = Math.floor(Date.now() / 1000);
const signedReceiptInput = async (fields: {
  wallet: ReturnType<typeof privateKeyToAccount>;
  bindingPayloadHash: string;
  txHash: string;
  transferLogIndex: number;
  sourceAddress: string;
  payoutAddress: string;
  amountAtomic: string;
  fundingRelationship?: "self" | "operator" | "affiliated" | "independent" | "unknown";
}) => {
  const fundingRelationship = fields.fundingRelationship ?? "independent";
  const funderStatement = payoutFunderStatement({
    bindingPayloadHash: fields.bindingPayloadHash,
    chainId: 8453,
    token: BASE_USDC,
    txHash: fields.txHash,
    transferLogIndex: fields.transferLogIndex,
    sourceAddress: fields.sourceAddress,
    payoutAddress: fields.payoutAddress,
    amountAtomic: fields.amountAtomic,
    fundingRelationship,
  });
  return {
    tx_hash: fields.txHash,
    transfer_log_index: fields.transferLogIndex,
    funding_relationship: fundingRelationship,
    funder_statement: funderStatement,
    funder_signature: await fields.wallet.signMessage({ message: funderStatement }),
  };
};
const hashPayload = (fields: readonly string[], payload: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(fields.map((field) => payload[field]))).digest("hex");

async function signedBinding() {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const fields = {
    handle: CITIZEN.handle,
    row: "earning-economy",
    amountAtomic: "10000000",
    chainId: 8453,
    token: BASE_USDC,
    address: wallet.address.toLowerCase(),
    expiry: NOW + 86400,
  };
  const preimage = payoutPreimage(fields);
  return {
    env: makeEnv(publicKey),
    wallet,
    privateKey: ed.privateKey,
    publicKey,
    preimage,
    body: {
      version: PAYOUT_VERSION,
      handle: fields.handle,
      row: fields.row,
      amount_atomic: fields.amountAtomic,
      chain_id: fields.chainId,
      token: fields.token,
      address: fields.address,
      expiry: fields.expiry,
      signature: await wallet.signMessage({ message: preimage }),
      citizen_public_key: publicKey,
      citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), ed.privateKey))),
      preimage,
    },
  };
}

test("the published payout-rail receipt is byte-compatible with the upstream validator", async () => {
  const receipt = JSON.parse(readFileSync(new URL("./fixtures/payout-rail-example.json", import.meta.url), "utf8"));
  const citizen = { ...CITIZEN, handle: receipt.handle };
  const env = makeEnv(receipt.citizen_public_key);
  const result = await validatePayoutBinding(env, citizen as never, receipt, 1_786_634_000);
  assert.equal(result.preimage, receipt.preimage);
  assert.equal(result.address, receipt.address.toLowerCase());
  assert.equal(result.authorizationHash.length, 64);
});

test("the exact payout-rail v1 fixture verifies both signatures and pins the active citizen key", async () => {
  const fixture = await signedBinding();
  const result = await validatePayoutBinding(fixture.env, CITIZEN as never, fixture.body, NOW);
  assert.equal(result.preimage, fixture.preimage);
  assert.equal(result.citizenKeyThumbprint, "citizen-tp");
  assert.equal(result.address, fixture.wallet.address.toLowerCase());
  assert.match(result.authorizationHash, /^[0-9a-f]{64}$/);
  assert.match(result.docketAcceptance ?? "", /payout binding recorded in the identity log/);
});

test("every scoped field is signed: mutating it makes at least one required half fail", async () => {
  for (const mutation of [
    { handle: "another-citizen" },
    { row: "treasury-governance" },
    { amount_atomic: "1000000000" },
    { chain_id: 1 },
    { token: "0x0000000000000000000000000000000000000001" },
    { address: "0x0000000000000000000000000000000000000001" },
    { expiry: NOW + 100 },
  ]) {
    const fixture = await signedBinding();
    await assert.rejects(
      validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, ...mutation, preimage: undefined }, NOW),
      (error: SocietyError) => [400, 403].includes(error.status),
      JSON.stringify(mutation),
    );
  }
});

test("both halves are mandatory and the citizen half must be an active key belonging to the authenticated citizen", async () => {
  const fixture = await signedBinding();
  for (const missing of ["signature", "citizen_public_key", "citizen_signature"] as const) {
    const body = { ...fixture.body, [missing]: undefined };
    await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, body, NOW), (e: SocietyError) => e.status === 400);
  }
  await assert.rejects(
    validatePayoutBinding(makeEnv(fixture.publicKey, "revoked"), CITIZEN as never, fixture.body, NOW),
    (e: SocietyError) => e.status === 400 && /active bound keys/.test(e.message),
  );
  await assert.rejects(
    validatePayoutBinding(makeEnv(fixture.publicKey, "active", 2), CITIZEN as never, fixture.body, NOW),
    (e: SocietyError) => e.status === 400 && /active bound keys/.test(e.message),
  );
});

test("canonical fields refuse display-layer lies, integer aliases, standing expiry, and invented rows", async () => {
  const fixture = await signedBinding();
  await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, version: "evil.v99" }, NOW), /version must be exactly/);
  await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, amount_atomic: "010000000", preimage: undefined }, NOW), /canonical positive integer/);
  await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, preimage: fixture.preimage + ":display-lie" }, NOW), /preimage does not match/);
  await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, expiry: NOW + 31 * 86400, preimage: undefined }, NOW), /standing wallet binding/);
  await assert.rejects(validatePayoutBinding(fixture.env, CITIZEN as never, { ...fixture.body, row: "invented-row", preimage: undefined }, NOW), /not in GET \/api\/docket/);
});

function makeFullEnv(publicKey: string, failAfterState = false) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE payout_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, version TEXT, amount_atomic TEXT,
      chain_id INTEGER, token TEXT, payout_address TEXT, expiry INTEGER, wallet_signature TEXT,
      wallet_proof_id INTEGER,
      citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT,
      citizen_key_bound_at INTEGER, authorization_verification TEXT, authorization_verified_at INTEGER, docket_acceptance TEXT,
      docket_updated TEXT, docket_snapshot TEXT, preimage TEXT, authorization_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE, created_at INTEGER,
      -- Mirrors schema.sql: exactly one proof of the wallet, never zero, never two.
      CHECK ((wallet_signature IS NOT NULL AND wallet_proof_id IS NULL)
          OR (wallet_signature IS NULL AND wallet_proof_id IS NOT NULL))
    );
    CREATE TABLE payout_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, version TEXT, chain_id INTEGER,
      address TEXT, expiry INTEGER, wallet_signature TEXT, citizen_public_key TEXT, citizen_signature TEXT,
      citizen_key_thumbprint TEXT, citizen_key_custody TEXT, citizen_key_bound_at INTEGER,
      preimage TEXT, proof_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE,
      created_at INTEGER, revoked_at INTEGER, revoke_reason TEXT
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
    CREATE TABLE payout_receipt_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, binding_id INTEGER, attempted_at INTEGER);
    INSERT INTO citizens VALUES (1, 'context-gardener', 'test', 'secret', 0, 0, 0);
  `);
  db.prepare("INSERT INTO keys VALUES (1, 1, ?, 'citizen-tp', 'self', 'active', 0)").run(publicKey);
  const d1 = {
    prepare: (sql: string) => new D1Statement(db, sql),
    async batch(statements: D1Statement[]) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (let i = 0; i < statements.length; i++) {
          results.push(statements[i]!.executeBatch());
          if (failAfterState && i === 0) throw new Error("D1_ERROR: simulated event append failure");
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { env: { DB: d1 } as unknown as Env, db };
}

test("binding state and its payout-binding identity event commit together", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const receipt = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  assert.equal(receipt.id, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 1);
  const event = db.prepare("SELECT kind, detail, hash FROM identity_events").get() as { kind: string; detail: string; hash: string };
  assert.equal(event.kind, "payout-binding");
  assert.equal(hashPayload(PAYOUT_BINDING_HASH_FIELDS, receipt.payload as Record<string, unknown>), receipt.payload_hash);
  assert.match(event.detail, new RegExp(String(receipt.payload_hash)));
  assert.equal(event.hash, receipt.chained);
  assert.equal(receipt.chain_anchor.identity_event, 1);
});

test("docket drift compares the complete canonical snapshot, not only its date", async () => {
  const fixture = await signedBinding();
  const { env } = makeFullEnv(fixture.publicKey);
  const binding = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  const row = DOCKET.find((item) => item.id === fixture.body.row)!;
  const originalAcceptance = row.acceptance;
  try {
    row.acceptance = `${originalAcceptance} same-day correction`;
    const detail = await getPayoutBinding(env, Number(binding.id));
    assert.equal(detail.docket_changed_since_binding, true);
    assert.notDeepEqual(detail.docket_at_binding, detail.docket_current);
  } finally {
    row.acceptance = originalAcceptance;
  }
});

test("later revocation cannot rewrite the stored as-of binding verdict or payload hash", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const created = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  const before = await getPayoutBinding(env, Number(created.id));
  db.prepare("UPDATE keys SET status = 'revoked' WHERE citizen_id = 1").run();
  const after = await getPayoutBinding(env, Number(created.id));
  assert.equal(after.authorization_verification, "valid-at-binding-event");
  assert.equal(after.citizen_key_custody, "self");
  assert.equal(after.payload_hash, before.payload_hash);
  assert.deepEqual(after.payload, before.payload);
  assert.equal(hashPayload(PAYOUT_BINDING_HASH_FIELDS, after.payload as Record<string, unknown>), after.payload_hash);
});

test("key revocation and binding serialize at the atomic commit boundary", async () => {
  const fixture = await signedBinding();

  const revokeFirst = makeFullEnv(fixture.publicKey);
  const dbApi = revokeFirst.env.DB as unknown as { batch: (statements: D1Statement[]) => Promise<unknown> };
  const originalBatch = dbApi.batch;
  dbApi.batch = async (statements) => {
    revokeFirst.db.prepare("UPDATE keys SET status = 'revoked' WHERE citizen_id = 1").run();
    return originalBatch(statements);
  };
  await assert.rejects(
    createPayoutBinding(revokeFirst.env, CITIZEN as never, fixture.body),
    (error: SocietyError) => error.status === 409 && /stopped being active/.test(error.message),
  );
  assert.equal((revokeFirst.db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 0);
  assert.equal((revokeFirst.db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 0);

  const bindFirst = makeFullEnv(fixture.publicKey);
  await createPayoutBinding(bindFirst.env, CITIZEN as never, fixture.body);
  bindFirst.db.prepare("UPDATE keys SET status = 'revoked' WHERE citizen_id = 1").run();
  assert.equal((bindFirst.db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 1);
  assert.equal((bindFirst.db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 1);
});

test("an authorization that expires during verification writes neither binding nor event", async () => {
  const fixture = await signedBinding();
  // The window between signing and the call has to fit inside the expiry, or
  // the wrong guard fires: validatePayoutBinding refuses an already-past expiry
  // with "expiry must be in the future when the binding is recorded" before the
  // batch delay below ever runs, and the test then asserts nothing about the
  // race it is named for. That is what happened on CI on 2026-08-26 (run
  // 32940818887, node 22.23.2), where the signing below took over a second on a
  // cold runner while the expiry was one second out.
  //
  // Two changes, because the clock here is real: the signing paths are warmed
  // first so the measured setup is not paying for their first call, and the
  // expiry is three seconds out against a delay of 3.5, so the ordering holds
  // with seconds of slack rather than milliseconds. society.ts reads
  // Date.now() directly for the "expired before" branch, so this cannot be
  // made deterministic by injecting a clock without changing that.
  await fixture.wallet.signMessage({ message: "warm" });
  edSign(null, Buffer.from("warm"), fixture.privateKey);
  const expiry = Math.floor(Date.now() / 1000) + 3;
  const preimage = payoutPreimage({
    handle: fixture.body.handle,
    row: fixture.body.row,
    amountAtomic: fixture.body.amount_atomic,
    chainId: fixture.body.chain_id,
    token: fixture.body.token,
    address: fixture.body.address,
    expiry,
  });
  const body = {
    ...fixture.body,
    expiry,
    preimage,
    signature: await fixture.wallet.signMessage({ message: preimage }),
    citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), fixture.privateKey))),
  };
  const { env, db } = makeFullEnv(fixture.publicKey);
  const dbApi = env.DB as unknown as { batch: (statements: D1Statement[]) => Promise<unknown> };
  const originalBatch = dbApi.batch;
  dbApi.batch = async (statements) => {
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    return originalBatch(statements);
  };
  await assert.rejects(
    createPayoutBinding(env, CITIZEN as never, body),
    (error: SocietyError) => error.status === 409 && /expired before/.test(error.message),
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 0);
});

test("a failed identity-event append rolls back the payout binding", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey, true);
  await assert.rejects(createPayoutBinding(env, CITIZEN as never, fixture.body), (error: SocietyError) => error.status === 500);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 0);
});

test("the rolling binding cap is enforced inside the state write without a phantom identity event", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  for (let i = 1; i <= 5; i++) {
    const amountAtomic = String(10_000_000 + i);
    const preimage = payoutPreimage({
      handle: fixture.body.handle,
      row: fixture.body.row,
      amountAtomic,
      chainId: fixture.body.chain_id,
      token: fixture.body.token,
      address: fixture.body.address,
      expiry: fixture.body.expiry,
    });
    await createPayoutBinding(env, CITIZEN as never, {
      ...fixture.body,
      amount_atomic: amountAtomic,
      preimage,
      signature: await fixture.wallet.signMessage({ message: preimage }),
      citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), fixture.privateKey))),
    });
  }
  const amountAtomic = "20000000";
  const preimage = payoutPreimage({
    handle: fixture.body.handle, row: fixture.body.row, amountAtomic,
    chainId: fixture.body.chain_id, token: fixture.body.token, address: fixture.body.address, expiry: fixture.body.expiry,
  });
  await assert.rejects(
    createPayoutBinding(env, CITIZEN as never, {
      ...fixture.body, amount_atomic: amountAtomic, preimage,
      signature: await fixture.wallet.signMessage({ message: preimage }),
      citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), fixture.privateKey))),
    }),
    (error: SocietyError) => error.status === 429,
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 5);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 5);
});

test("same-millisecond identical fifth requests cannot alias the event guard", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const signedAmount = async (amountAtomic: string) => {
    const preimage = payoutPreimage({
      handle: fixture.body.handle,
      row: fixture.body.row,
      amountAtomic,
      chainId: fixture.body.chain_id,
      token: fixture.body.token,
      address: fixture.body.address,
      expiry: fixture.body.expiry,
    });
    return {
      ...fixture.body,
      amount_atomic: amountAtomic,
      preimage,
      signature: await fixture.wallet.signMessage({ message: preimage }),
      citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), fixture.privateKey))),
    };
  };
  for (let i = 0; i < 4; i++) await createPayoutBinding(env, CITIZEN as never, await signedAmount(String(30_000_000 + i)));
  const fifth = await signedAmount("40000000");

  // Hold both duplicate prechecks until both requests have observed absence,
  // then let their batches serialize at the 4->5 cap boundary.
  const dbApi = env.DB as unknown as { prepare: (sql: string) => D1Statement };
  const originalPrepare = dbApi.prepare;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let prechecks = 0;
  dbApi.prepare = (sql) => {
    const stmt = originalPrepare(sql);
    if (sql === "SELECT id FROM payout_bindings WHERE authorization_hash = ? LIMIT 1") {
      const originalFirst = stmt.first.bind(stmt);
      (stmt as unknown as { first: () => Promise<unknown> }).first = async () => {
        prechecks++;
        if (prechecks === 2) release();
        await gate;
        return originalFirst();
      };
    }
    return stmt;
  };
  const realNow = Date.now;
  Date.now = () => 1_786_637_000_000;
  try {
    const results = await Promise.allSettled([
      createPayoutBinding(env, CITIZEN as never, fifth),
      createPayoutBinding(env, CITIZEN as never, fifth),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const loser = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.ok(loser);
    assert.equal((loser.reason as SocietyError).status, 429);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_bindings").get() as { n: number }).n, 5);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 5);
    assert.equal((db.prepare("SELECT COUNT(DISTINCT commit_nonce) AS n FROM payout_bindings").get() as { n: number }).n, 5);
  } finally {
    Date.now = realNow;
    dbApi.prepare = originalPrepare;
  }
});

test("a reproduced finalized Base-USDC transfer joins binding, docket, and a second atomic identity event", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const binding = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  const txHash = "0x" + "ab".repeat(32);
  const blockHash = "0x" + "cd".repeat(32);
  const funder = privateKeyToAccount(generatePrivateKey());
  const from = funder.address.toLowerCase();
  const transferTopicLocal = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (address: string) => "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
  const amount = "0x" + BigInt(fixture.body.amount_atomic).toString(16).padStart(64, "0");
  // Same-second ordering is unknowable at block timestamp resolution and is accepted.
  const blockTimestamp = Math.floor(Number(binding.created_at) / 1000);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const result = request.method === "eth_getTransactionReceipt"
      ? {
          status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash,
          from, logs: [{ address: BASE_USDC, topics: [transferTopicLocal, topic(from), topic(fixture.body.address)], data: amount, logIndex: "0x3" }],
        }
      : request.method === "eth_chainId" ? "0x2105"
      : request.method === "eth_blockNumber" ? "0x70"
      : { hash: blockHash, number: "0x64", timestamp: "0x" + blockTimestamp.toString(16) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    const stranger = privateKeyToAccount(generatePrivateKey());
    const wrong = await signedReceiptInput({
      wallet: stranger,
      bindingPayloadHash: String(binding.payload_hash),
      txHash,
      transferLogIndex: 3,
      sourceAddress: from,
      payoutAddress: String(fixture.body.address),
      amountAtomic: String(fixture.body.amount_atomic),
    });
    await assert.rejects(
      createPayoutReceipt(env, CITIZEN as never, Number(binding.id), wrong),
      (error: SocietyError) => error.status === 400 && /not the exact Transfer source/.test(error.message),
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipts").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 1);

    const paid = await createPayoutReceipt(
      env,
      CITIZEN as never,
      Number(binding.id),
      await signedReceiptInput({
        wallet: funder,
        bindingPayloadHash: String(binding.payload_hash),
        txHash,
        transferLogIndex: 3,
        sourceAddress: from,
        payoutAddress: String(fixture.body.address),
        amountAtomic: String(fixture.body.amount_atomic),
      }),
    );
    assert.equal(paid.transfer_log_index, 3);
    assert.equal(paid.finalized_block_number, 100);
    assert.equal(paid.docket_id, "earning-economy");
    assert.equal(paid.funder_address, from);
    assert.equal(paid.funder_statement, paid.payload.funder_statement);
    assert.equal(paid.funding_relationship, "independent");
    assert.equal(hashPayload(PAYOUT_RECEIPT_HASH_FIELDS, paid.payload as Record<string, unknown>), paid.payload_hash);
    for (const field of ["submitter_id", "confirmations_at_recording", "checked_at", "created_at"]) {
      const changed = { ...(paid.payload as Record<string, unknown>), [field]: Number((paid.payload as Record<string, unknown>)[field]) + 1 };
      assert.notEqual(hashPayload(PAYOUT_RECEIPT_HASH_FIELDS, changed), paid.payload_hash, `${field} must be anchored`);
    }
    const detail = await getPayoutBinding(env, Number(binding.id));
    assert.equal(hashPayload(PAYOUT_BINDING_HASH_FIELDS, detail.payload as Record<string, unknown>), detail.payload_hash);
    assert.ok(detail.receipt);
    assert.equal(hashPayload(PAYOUT_RECEIPT_HASH_FIELDS, detail.receipt.payload as Record<string, unknown>), detail.receipt.payload_hash);
    assert.equal(detail.chain_anchor?.identity_event, 1);
    assert.equal(detail.receipt.chain_anchor?.identity_event, 2);
    const listed = await listPayouts(env, null);
    assert.equal(listed.bindings[0]?.record, `/api/payout-bindings/${binding.id}`);
    assert.equal(listed.bindings[0]?.receipt_payload_hash, paid.payload_hash);
    assert.equal(listed.bindings[0]?.funder_address, from);
    assert.equal(listed.bindings[0]?.funder_attestation_hash, paid.funder_attestation_hash);
    assert.equal(listed.bindings[0]?.docket_changed_since_binding, false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipts").get() as { n: number }).n, 1);
    const events = db.prepare("SELECT kind FROM identity_events ORDER BY id").all() as { kind: string }[];
    assert.deepEqual(events.map((event) => event.kind), ["payout-binding", "payout-receipt"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("receipt-attempt pruning drops only expired rows and cannot reopen the hourly cap", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const binding = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  const now = Date.now();
  db.prepare("INSERT INTO payout_receipt_attempts (citizen_id, binding_id, attempted_at) VALUES (1, ?, ?)").run(binding.id, now - 3_600_001);
  for (let i = 0; i < 10; i++)
    db.prepare("INSERT INTO payout_receipt_attempts (citizen_id, binding_id, attempted_at) VALUES (1, ?, ?)").run(binding.id, now - i);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("RPC must not be called after the cap"); }) as typeof fetch;
  try {
    await assert.rejects(
      createPayoutReceipt(env, CITIZEN as never, Number(binding.id), {
        tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "unknown",
        funder_statement: "placeholder", funder_signature: "0x" + "11".repeat(65),
      }),
      (error: SocietyError) => error.status === 429,
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipt_attempts").get() as { n: number }).n, 10);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipt_attempts WHERE attempted_at <= ?").get(now - 3_600_000) as { n: number }).n, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an old orphan block hash is not accepted merely because its height is finalized", async () => {
  const fixture = await signedBinding();
  const { env, db } = makeFullEnv(fixture.publicKey);
  const binding = await createPayoutBinding(env, CITIZEN as never, fixture.body);
  const txHash = "0x" + "ab".repeat(32);
  const orphanHash = "0x" + "cd".repeat(32);
  const canonicalHash = "0x" + "ef".repeat(32);
  const from = "0x2222222222222222222222222222222222222222";
  const amount = "0x" + BigInt(fixture.body.amount_atomic).toString(16).padStart(64, "0");
  const blockTimestamp = Math.floor(Date.now() / 1000) + 2;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const result = request.method === "eth_getTransactionReceipt"
      ? {
          status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash: orphanHash,
          from, logs: [{ address: BASE_USDC, topics: [transferTopic, topicAddress(from), topicAddress(fixture.body.address)], data: amount, logIndex: "0x3" }],
        }
      : request.method === "eth_chainId" ? "0x2105"
      : request.method === "eth_blockNumber" ? "0x70"
      : request.params[0] === "finalized" ? { hash: canonicalHash, number: "0x64", timestamp: "0x" + blockTimestamp.toString(16) }
      : { hash: canonicalHash, number: "0x64", timestamp: "0x" + blockTimestamp.toString(16) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      createPayoutReceipt(env, CITIZEN as never, Number(binding.id), {
        tx_hash: txHash, transfer_log_index: 3, funding_relationship: "unknown",
        funder_statement: "placeholder", funder_signature: "0x" + "11".repeat(65),
      }),
      (error: SocietyError) => error.status === 409 && /not canonical/.test(error.message),
    );
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipts").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const topicAddress = (address: string) => "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");

test("the exact Transfer source must sign one canonical binding+tx+log assignment", async () => {
  const funder = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const binding = {
    payload_hash: "a".repeat(64), chain_id: 8453, token: BASE_USDC,
    payout_address: "0x1111111111111111111111111111111111111111", amount_atomic: "10000000",
  } as never;
  const payment = {
    txHash: "0x" + "ab".repeat(32), transferLogIndex: 7,
    sourceAddress: funder.address.toLowerCase(), transactionSender: funder.address.toLowerCase(),
    blockNumber: 100, blockHash: "0x" + "cd".repeat(32), blockTimestamp: 1_500,
    finalizedBlockNumber: 100, confirmations: 13, checkedAt: 1,
  };
  const statement = payoutFunderStatement({
    bindingPayloadHash: binding.payload_hash, chainId: binding.chain_id, token: binding.token,
    txHash: payment.txHash, transferLogIndex: payment.transferLogIndex, sourceAddress: payment.sourceAddress,
    payoutAddress: binding.payout_address, amountAtomic: binding.amount_atomic, fundingRelationship: "independent",
  });
  const validInput = validateReceiptInput({
    tx_hash: payment.txHash, transfer_log_index: 7, funding_relationship: "independent",
    funder_statement: statement, funder_signature: await funder.signMessage({ message: statement }),
  });
  const verified = await verifyFunderAttestation(binding, payment, validInput);
  assert.equal(verified.funderAddress, payment.sourceAddress);
  assert.equal(verified.statement, statement);
  assert.match(verified.attestationHash, /^[0-9a-f]{64}$/);

  for (const changed of [
    { binding_payload_hash: "b".repeat(64) },
    { chain_id: 1 },
    { token: "0x3333333333333333333333333333333333333333" },
    { tx_hash: "0x" + "ef".repeat(32) },
    { transfer_log_index: 8 },
    { source_address: stranger.address.toLowerCase() },
    { payout_address: "0x4444444444444444444444444444444444444444" },
    { amount_atomic: "10000001" },
    { funding_relationship: "unknown" },
  ]) {
    const mutated = statement
      .replace(binding.payload_hash, String(changed.binding_payload_hash ?? binding.payload_hash))
      .replace(":8453:", `:${String(changed.chain_id ?? 8453)}:`)
      .replace(binding.token, String(changed.token ?? binding.token))
      .replace(payment.txHash, String(changed.tx_hash ?? payment.txHash))
      .replace(":7:", `:${String(changed.transfer_log_index ?? 7)}:`)
      .replace(payment.sourceAddress, String(changed.source_address ?? payment.sourceAddress))
      .replace(binding.payout_address, String(changed.payout_address ?? binding.payout_address))
      .replace(":10000000:", `:${String(changed.amount_atomic ?? "10000000")}:`)
      .replace(/:independent$/, `:${String(changed.funding_relationship ?? "independent")}`);
    await assert.rejects(
      verifyFunderAttestation(binding, payment, { ...validInput, funderStatement: mutated }),
      /does not match the canonical statement/,
    );
  }

  const wrongSignature = await stranger.signMessage({ message: statement });
  await assert.rejects(
    verifyFunderAttestation(binding, payment, { ...validInput, funderSignature: wrongSignature }),
    /not the exact Transfer source/,
  );
});

test("RPC verification rejects reverted, missing, pre-binding, expired, unfinalized, and unavailable payments", async () => {
  const payee = "0x1111111111111111111111111111111111111111";
  const funder = "0x2222222222222222222222222222222222222222";
  const txHash = "0x" + "ab".repeat(32);
  const blockHash = "0x" + "cd".repeat(32);
  const amount = word(10_000_000n);
  const binding = {
    chain_id: 8453,
    token: BASE_USDC,
    payout_address: payee,
    amount_atomic: "10000000",
    created_at: 1_000_000,
    expiry: 2_000,
  } as never;

  const run = async (scenario: { receipt?: null | Record<string, unknown>; timestamp?: number; finalized?: number; unavailable?: boolean }) => {
    const receipt = scenario.receipt === undefined
      ? {
          status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash, from: funder,
          logs: [{ address: BASE_USDC, topics: [transferTopic, topicAddress(funder), topicAddress(payee)], data: amount, logIndex: "0x1" }],
        }
      : scenario.receipt;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (scenario.unavailable) throw new Error("down");
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const result = request.method === "eth_getTransactionReceipt" ? receipt
        : request.method === "eth_chainId" ? "0x2105"
        : request.method === "eth_blockNumber" ? "0x70"
        : request.params[0] === "finalized" ? { hash: blockHash, number: "0x" + (scenario.finalized ?? 100).toString(16), timestamp: "0x5dc" }
        : { hash: blockHash, number: "0x64", timestamp: "0x" + (scenario.timestamp ?? 1_500).toString(16) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
    }) as typeof fetch;
    try {
      return await verifyBasePayment({} as Env, binding, txHash, null, 1234);
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  await assert.rejects(run({ receipt: { status: "0x0", transactionHash: txHash, blockNumber: "0x64", blockHash, from: funder, logs: [] } }), (e: SocietyError) => e.status === 400 && /did not succeed/.test(e.message));
  await assert.rejects(run({ receipt: null }), (e: SocietyError) => e.status === 409 && /not found/.test(e.message));
  await assert.rejects(run({ timestamp: 999 }), (e: SocietyError) => e.status === 400 && /predates/.test(e.message));
  await assert.rejects(run({ timestamp: 2_000 }), (e: SocietyError) => e.status === 400 && /at or after/.test(e.message));
  await assert.rejects(run({ finalized: 99 }), (e: SocietyError) => e.status === 409 && /finalized/.test(e.message));
  await assert.rejects(run({ unavailable: true }), (e: SocietyError) => e.status === 503 && /two-source/.test(e.message));
});

test("two-versus-two RPC disagreement cannot become a permanent payment fact", async () => {
  const payee = "0x1111111111111111111111111111111111111111";
  const funder = "0x2222222222222222222222222222222222222222";
  const txHash = "0x" + "ab".repeat(32);
  const hashA = "0x" + "aa".repeat(32);
  const hashB = "0x" + "bb".repeat(32);
  const binding = { chain_id: 8453, token: BASE_USDC, payout_address: payee, amount_atomic: "10000000", created_at: 1_000_000, expiry: 2_000 } as never;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    // Only four providers answer, two each way, so this stays a genuine TWO
    // VERSUS TWO however long the real provider list grows. The earlier version
    // split "these two" against "everything else", so widening the pool on
    // 2026-08-16 silently turned the tie into a 2-7 majority and the test
    // stopped testing a tie while still passing.
    const answering = ["mainnet.base.org", "publicnode", "drpc.org", "1rpc.io"];
    if (!answering.some((host) => String(url).includes(host))) throw new Error("provider unavailable");
    const firstPair = String(url).includes("mainnet.base.org") || String(url).includes("publicnode");
    const blockHash = firstPair ? hashA : hashB;
    const result = request.method === "eth_getTransactionReceipt"
      ? { status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash, from: funder, logs: [{ address: BASE_USDC, topics: [transferTopic, topicAddress(funder), topicAddress(payee)], data: word(10_000_000n), logIndex: "0x1" }] }
      : request.method === "eth_chainId" ? "0x2105"
      : request.method === "eth_blockNumber" ? "0x70"
      : { hash: blockHash, number: "0x64", timestamp: "0x5dc" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      verifyBasePayment({} as Env, binding, txHash, null),
      (error: SocietyError) => error.status === 503 && /did not produce one/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("payment matching is exact on token, recipient, amount and log index", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const from = "0x2222222222222222222222222222222222222222";
  const receipt = {
    status: "0x1",
    from: "0x3333333333333333333333333333333333333333",
    logs: [{ address: BASE_USDC, topics: [transferTopic, topicAddress(from), topicAddress(to)], data: word(10_000_000n), logIndex: "0x7" }],
  };
  const binding = { token: BASE_USDC, payout_address: to, amount_atomic: "10000000" };
  assert.deepEqual(matchTransfer(receipt, binding, null), { transferLogIndex: 7, sourceAddress: from, transactionSender: receipt.from });
  assert.throws(() => matchTransfer(receipt, { ...binding, amount_atomic: "9999999" }, null), /no exact token Transfer/);
  assert.throws(() => matchTransfer(receipt, { ...binding, token: "0x4444444444444444444444444444444444444444" }, null), /no exact token Transfer/);
  assert.throws(() => matchTransfer(receipt, { ...binding, payout_address: "0x4444444444444444444444444444444444444444" }, null), /no exact token Transfer/);
  assert.throws(() => matchTransfer(receipt, binding, 8), /log index 8/);
});

test("self-transfers and circular same-transaction flows are not payment", () => {
  const payee = "0x1111111111111111111111111111111111111111";
  const funder = "0x2222222222222222222222222222222222222222";
  const other = "0x3333333333333333333333333333333333333333";
  const log = (from: string, to: string, index: string) => ({
    address: BASE_USDC,
    topics: [transferTopic, topicAddress(from), topicAddress(to)],
    data: word(10_000_000n),
    logIndex: index,
  });
  const binding = { token: BASE_USDC, payout_address: payee, amount_atomic: "10000000" };
  assert.throws(
    () => matchTransfer({ status: "0x1", from: payee, logs: [log(payee, payee, "0x1")] }, binding, null),
    /self-transfer does not pay/,
  );
  assert.throws(
    () => matchTransfer({ status: "0x1", from: funder, logs: [log(funder, payee, "0x1"), log(payee, other, "0x2")] }, binding, 1),
    /does not produce a net inflow of the bound asset/,
  );
});

test("ambiguous matching transfers require a log index and relationships use a closed honest vocabulary", () => {
  const to = "0x1111111111111111111111111111111111111111";
  const from = "0x2222222222222222222222222222222222222222";
  const mk = (i: string) => ({ address: BASE_USDC, topics: [transferTopic, topicAddress(from), topicAddress(to)], data: word(10_000_000n), logIndex: i });
  const receipt = { status: "0x1", from, logs: [mk("0x1"), mk("0x2")] };
  const binding = { token: BASE_USDC, payout_address: to, amount_atomic: "10000000" };
  assert.throws(() => matchTransfer(receipt, binding, null), /more than one matching/);
  assert.equal(matchTransfer(receipt, binding, 2).transferLogIndex, 2);
  const signature = "0x" + "11".repeat(65);
  assert.deepEqual(validateReceiptInput({
    tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "independent",
    funder_statement: "statement", funder_signature: signature,
  }), {
    txHash: "0x" + "ab".repeat(32), transferLogIndex: 0, fundingRelationship: "independent",
    funderStatement: "statement", funderSignature: signature,
  });
  assert.throws(() => validateReceiptInput({
    tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "definitely-unrelated",
    funder_statement: "statement", funder_signature: signature,
  }), /must be one of/);
  assert.throws(() => validateReceiptInput({
    tx_hash: "0x" + "ab".repeat(32), funding_relationship: "independent",
    funder_statement: "statement", funder_signature: signature,
  }), /transfer_log_index/);
  assert.throws(() => validateReceiptInput({
    tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "independent",
    funder_signature: signature,
  }), /funder_statement/);
  assert.throws(() => validateReceiptInput({
    tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "independent",
    funder_statement: "statement",
  }), /funder_signature/);
});

test("every payment write surface warns contract-wallet funders before funds move", () => {
  for (const file of ["../src/doc.ts", "../src/surface.ts", "../src/mcp.ts"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(text, /EOA|externally owned/i, `${file} must state the v1 EOA-only scope`);
    assert.match(text, /Safe/, `${file} must name the common contract-wallet failure case`);
    assert.match(text, /ERC-1271/, `${file} must name the contract-wallet follow-up`);
    assert.match(text, /after (?:funds move|payment)/, `${file} must warn before an irreversible transfer`);
  }
});

// GUARD (live outage, 2026-08-16). Every public Base RPC in baseRpcUrls answers
// 403 to a request carrying no User-Agent. Without the header all four
// providers fail, none of them votes, and readUsdcBalanceTwoSource raises
// "Base RPC providers did not agree on the funder wallet's USDC balance" on
// every listing that names a paying wallet. The rail stopped accepting funded
// listings entirely and the message blamed the chain for what was a refusal at
// our own door. Mutation-verified: drop the header and this goes red.
test("the Base RPC helper sends a User-Agent, or every provider refuses us", () => {
  const src = readFileSync(new URL("../src/payouts.ts", import.meta.url), "utf8");
  const i = src.indexOf("async function rpc(rpcUrl: string");
  assert.ok(i > 0, "the rpc helper moved; this guard is pointed at nothing");
  assert.match(
    src.slice(i, i + 700),
    /"user-agent"\s*:/,
    "the Base RPC fetch must set a user-agent; without it every provider answers 403 and the rail reports a disagreement that never happened",
  );
});
