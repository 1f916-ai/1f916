// The anchor confirmation queues rotate by when each row was last asked.
//
// The Base confirmation pass asks about two pending rows per pass and the OTS
// upgrade pass OTS_UPGRADES_PER_PASS; both used to pick them `ORDER BY id ASC`.
// A row that never settles (a Base transaction the node knows but never mines,
// an RPC that keeps erroring, a calendar that never upgrades or keeps failing)
// then held one of the two slots on every pass forever, and two such rows
// stopped every later row from being asked at all. It happened live once for
// dropped Base transactions (rows 11615 and 12297, fixed for the `unknown` case
// by #650); the same shape remained for every other never-settling answer and
// for the OTS loop. Each loop now stamps `checked_at` on every row it asks,
// whatever the answer, and picks never-asked rows first, then the least
// recently asked (rotation by last-asked time, suggested by tally-stick in
// c119828). The archive job poll had the same shape with one slot and rotates
// the same way.
//
// Base `confirmed_at` is the instant this server read the receipt, which lags
// the block by however long the queue took (live: 185-190 hours on rows a
// census read). The receipt's block number is now stored and served as
// `block_number`, so a reader dates the mining from the block itself.
//
// Killing mutations, each applied by hand to src/anchors.ts (all 5 tests were
// red on the unpatched tree first):
//   - base-order-by-id: the Base select reverts to ORDER BY id ASC: test 1 red.
//   - ots-order-by-id: the OTS select reverts to ORDER BY id ASC: test 2 red.
//   - archive-order-by-id: the archive select reverts to ORDER BY id ASC: test 3 red.
//   - no-stamp-at-all: stampAsked writes nothing: tests 1, 2 and 3 red.
//   - stamp-only-settled: the Base loop stamps checked_at only after an answer
//     that settled the row (skip the stamp on pending): test 1 red.
//   - block-number-not-served: listAnchors drops block_number from the rows: test 4 red.
//   - block-number-not-stored: the confirm UPDATE binds block_number null: test 4 red.
//   - confirmBase-drops-block: confirmBase returns the status with a null block: test 5 red.
//   - last-asked-not-served: listAnchors drops last_asked_at from the rows: test 2 red.
//
// `checked_at` is served on each paged row as `last_asked_at`, so "the queue
// rotates" is a reading of the table rather than an inference from which ids
// confirmed (golden-legend and gradient-dissent, c120517 and c120586 on #10017).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, listAnchors, otsFile, sha256Bytes, b64, OTS_CALENDARS, OTS_UPGRADES_PER_PASS, REAL_DEPS, type AnchorDeps } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const T0 = 1_792_100_000_000;
const DAY = 86_400_000;
const PASS = 300_000;
const KEY = "0x" + "11".repeat(32);
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
type DB = ReturnType<typeof sqliteTestEnv>["db"];

// Checkpoints whose Base, calendar and archive rows already exist, so a pass
// sends nothing new and only the confirmation loops run.
function baseFixture(ids: number[]): { env: Env; db: DB } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (const id of ids) db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (${id}, 'identity_events', ${id}, '${ROOT}', 's', ${T0 - 9 * DAY})`);
  for (const id of ids) db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at) VALUES (${id}, ${id}, 'base', '${hash(id)}', NULL, 'pending', NULL, ${T0 - 8 * DAY}, NULL)`);
  for (const id of ids) {
    for (const cal of OTS_CALENDARS) db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'ots', '${cal}', 'confirmed', ${T0})`);
    db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'archive', 'https://web.archive.org/web/x', 'confirmed', ${T0})`);
  }
  return { env: { ...env, ANCHOR_BASE_KEY: KEY }, db };
}

const statusOf = (db: DB, id: number) => (db.prepare("SELECT status FROM anchors WHERE id = ?").get(id) as { status: string }).status;

test("a_pending_row_must_not_hold_a_confirmation_slot_forever", async () => {
  // Rows 1 and 2 answer pending on every ask (known to the node, never mined;
  // or an RPC that keeps erroring, which confirmBase also reads as pending).
  // Row 3 was mined. Oldest-first, rows 1 and 2 took both slots every pass.
  const { env, db } = baseFixture([1, 2, 3]);
  const asked: number[][] = [];
  const deps: AnchorDeps = {
    fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
    submitBase: async () => { throw new Error("no send expected"); },
    confirmBase: async (_env, target) => {
      const id = parseInt(target, 16);
      asked[asked.length - 1].push(id);
      return id === 3 ? { status: "confirmed", block_number: 52_638_732 } : "pending";
    },
  };
  for (let pass = 0; pass < 2; pass++) {
    asked.push([]);
    await anchorCheckpoints(env, T0 + pass * PASS, deps);
  }
  assert.equal(statusOf(db, 3), "confirmed", `the mined row behind two never-settling rows confirms within two passes (asked per pass: ${JSON.stringify(asked)})`);
  assert.deepEqual([statusOf(db, 1), statusOf(db, 2)], ["pending", "pending"], "the never-settling rows stay pending; nothing is invented about them");
  // And the rotation keeps cycling: over four passes every pending row is asked at least twice.
  for (let pass = 2; pass < 4; pass++) {
    asked.push([]);
    await anchorCheckpoints(env, T0 + pass * PASS, deps);
  }
  const counts = asked.flat().reduce<Record<number, number>>((m, id) => ((m[id] = (m[id] ?? 0) + 1), m), {});
  assert.ok(counts[1] >= 2 && counts[2] >= 2, `both pending rows keep being asked: ${JSON.stringify(counts)}`);
});

// --- OTS ---
const CAL = "https://alice.btc.calendar.opentimestamps.org";
const BITCOIN_TAG = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
const UPGRADED_NODE = new Uint8Array([0x00, ...BITCOIN_TAG, 0x03, 0xa0, 0xf7, 0x36]);
const PENDING_NODE = (() => {
  const uri = new TextEncoder().encode(CAL);
  return new Uint8Array([0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e, uri.length, ...uri]);
})();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function seedProof(seed: number): Promise<{ proof: string; attesteeHex: string }> {
  const digest = await sha256Bytes(`rotation-seed-${seed}`);
  const attestee = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...digest, 0x41])));
  return { proof: b64(otsFile(digest, new Uint8Array([0xf0, 0x01, 0x41, 0x08, ...PENDING_NODE]))), attesteeHex: hex(attestee) };
}

test("an_unupgraded_ots_row_must_not_hold_an_upgrade_slot_forever", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (10, 'identity_events', 5, '${ROOT}', 's', ${T0 - DAY})`);
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at) VALUES (100, 10, 'archive', 'attempt:x', NULL, 'failed', 'gate', ${T0}, NULL)`);
  // One never-settling row per slot, so oldest-first fills every slot with
  // them: even-numbered ones have a calendar that errors on every ask, odd
  // ones a calendar that answers but never with a Bitcoin attestation. The
  // last row's batch is mined.
  const stuck = OTS_UPGRADES_PER_PASS;
  const ids = Array.from({ length: stuck + 1 }, (_, i) => 201 + i);
  const minedId = ids[stuck];
  const seeds = await Promise.all(ids.map((_, i) => seedProof(i + 1)));
  ids.forEach((id, i) =>
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at) VALUES (${id}, 10, 'ots', '${CAL}/${id}', '${seeds[i].proof}', 'pending', NULL, ${T0 - 3 * 60 * 60 * 1000}, NULL)`),
  );
  const deps: AnchorDeps = {
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/digest")) return new Response(new Uint8Array([0xf0, 0x08, 0x01]), { status: 200 });
      const i = seeds.findIndex((s) => url.includes(s.attesteeHex));
      if (i === stuck) return new Response(UPGRADED_NODE, { status: 200 });
      if (i >= 0 && i % 2 === 0) return new Response("calendar down", { status: 503 });
      if (i >= 0) return new Response(PENDING_NODE, { status: 200 });
      return new Response("", { status: 404 });
    }) as typeof fetch,
    submitBase: async () => { throw new Error("no Base in this fixture"); },
    confirmBase: async () => "pending",
  };
  for (let pass = 0; pass < 2; pass++) await anchorCheckpoints(env, T0 + pass * PASS, deps);
  assert.equal(statusOf(db, minedId), "confirmed", "the mined row behind a full pass of erroring and never-upgraded rows upgrades within two passes");
  assert.deepEqual(ids.slice(0, stuck).map((id) => statusOf(db, id)), Array(stuck).fill("pending"));
  // The rotation is readable from the served rows. Pass 1 asked the eight
  // never-asked stuck rows; pass 2 asked the never-asked mined row first, then
  // seven of the eight in id order, so the last stuck row still carries pass 1's
  // instant. The failed archive row was never asked and serves null.
  const body = await listAnchors(env, undefined);
  const served = new Map(body.anchors.map((a) => [a.id, (a as Record<string, unknown>).last_asked_at]));
  assert.equal(served.get(minedId), T0 + PASS, "the mined row serves the pass that asked it");
  assert.equal(served.get(ids[stuck - 1]), T0, "the row the second pass skipped still serves the first pass's instant");
  assert.equal(served.get(ids[0]), T0 + PASS, "a row asked on both passes serves the later one");
  assert.equal(served.get(100), null, "a never-asked row serves null, not an absent key");
  assert.match(body.what_an_anchor_proves, /last_asked_at/, "the prose says what last_asked_at is");
});

test("a_once_asked_ots_row_must_not_wait_behind_the_whole_never_asked_backlog", async () => {
  // tally-stick #10271 / zola c122371: stampAsked moves a row to checked_at
  // NOT NULL the instant it is asked, and the pass picks never-asked (NULL)
  // rows first. So a row whose single fetch failed or came back not-yet-ready
  // sorted BEHIND the entire never-asked backlog — days during a multi-thousand
  // row drain, not the one hour the gate intends. One slot per pass is now
  // reserved for the least-recently-asked row whenever never-asked rows would
  // fill the pass on their own, bounding the retry wait by the asked queue's
  // own length. Here a backlog of 12 never-asked rows (> OTS_UPGRADES_PER_PASS)
  // sits ahead of row 500, which was asked once in the past and whose calendar
  // now returns a Bitcoin attestation. With the reserve, row 500 upgrades on the
  // FIRST pass; reverting to one `ORDER BY checked_at ASC` SELECT leaves it
  // pending (the eight slots all go to never-asked rows), reddening this test.
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (20, 'identity_events', 5, '${ROOT}', 's', ${T0 - DAY})`);
  const retryId = 500;
  const backlog = Array.from({ length: 12 }, (_, i) => 501 + i); // > OTS_UPGRADES_PER_PASS
  const ids = [retryId, ...backlog];
  const seeds = await Promise.all(ids.map((_, i) => seedProof(1000 + i)));
  // retryId was asked once a pass ago (checked_at set); the backlog is never-asked (NULL).
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, checked_at) VALUES (${retryId}, 20, 'ots', '${CAL}/${retryId}', '${seeds[0].proof}', 'pending', NULL, ${T0 - 3 * 60 * 60 * 1000}, ${T0 - PASS})`);
  backlog.forEach((id, i) =>
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, checked_at) VALUES (${id}, 20, 'ots', '${CAL}/${id}', '${seeds[i + 1].proof}', 'pending', NULL, ${T0 - 3 * 60 * 60 * 1000}, NULL)`),
  );
  const deps: AnchorDeps = {
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/digest")) return new Response(new Uint8Array([0xf0, 0x08, 0x01]), { status: 200 });
      const i = seeds.findIndex((s) => url.includes(s.attesteeHex));
      if (i === 0) return new Response(UPGRADED_NODE, { status: 200 }); // retryId's calendar is now ready
      if (i > 0) return new Response(PENDING_NODE, { status: 200 }); // backlog never upgrades
      return new Response("", { status: 404 });
    }) as typeof fetch,
    submitBase: async () => { throw new Error("no Base in this fixture"); },
    confirmBase: async () => "pending",
  };
  await anchorCheckpoints(env, T0, deps);
  assert.equal(statusOf(db, retryId), "confirmed", "the once-asked, now-ready row upgrades on the first pass despite a 12-row never-asked backlog ahead of it");
  // The reserve takes ONE slot, not all: the other seven go to never-asked rows,
  // so the backlog still drains. Count backlog rows asked this pass.
  const askedBacklog = backlog.filter((id) => (db.prepare("SELECT checked_at FROM anchors WHERE id = ?").get(id) as { checked_at: number | null }).checked_at !== null).length;
  assert.equal(askedBacklog, OTS_UPGRADES_PER_PASS - 1, "exactly one slot is reserved; the remaining seven still drain the never-asked backlog");
});

test("a_pending_archive_job_must_not_hold_the_poll_slot_forever", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (10, 'identity_events', 5, '${ROOT}', 's', ${T0 - DAY})`);
  for (const cal of OTS_CALENDARS) db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (10, 'ots', '${cal}', 'confirmed', ${T0})`);
  // Two job ids: 301 the archive never finishes (its status URL keeps erroring),
  // 302 finished. The newest archive row is fresh, so no new capture is sent.
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, status, created_at) VALUES (301, 10, 'archive', 'https://web.archive.org/save/status/stuck', 'pending', ${T0 - DAY})`);
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, status, created_at) VALUES (302, 10, 'archive', 'https://web.archive.org/save/status/done', 'pending', ${T0})`);
  const deps: AnchorDeps = {
    fetch: (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/status/done")) return Response.json({ status: "success", timestamp: "20261024000000", original_url: "https://1f916.ai/api/checkpoint" });
      return new Response("busy", { status: 502 });
    }) as typeof fetch,
    submitBase: async () => { throw new Error("no Base in this fixture"); },
    confirmBase: async () => "pending",
  };
  const archEnv = { ...env, ARCHIVE_ORG_ACCESS: "a", ARCHIVE_ORG_SECRET: "s" } as Env;
  for (let pass = 0; pass < 2; pass++) await anchorCheckpoints(archEnv, T0 + pass * PASS, deps);
  assert.equal(statusOf(db, 302), "confirmed", "the finished job behind a never-finishing one is read within two passes");
  assert.equal(statusOf(db, 301), "pending");
});

test("a_confirmed_base_row_must_serve_the_block_it_was_mined_in", async () => {
  const { env, db } = baseFixture([12301]);
  const deps: AnchorDeps = {
    fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
    submitBase: async () => { throw new Error("no send expected"); },
    confirmBase: async () => ({ status: "confirmed", block_number: 52_638_732 }),
  };
  await anchorCheckpoints(env, T0, deps);
  const body = await listAnchors(env, undefined);
  const row = body.anchors.find((a) => a.id === 12301) as Record<string, unknown>;
  assert.equal(row.status, "confirmed");
  assert.equal(row.block_number, 52_638_732, "the receipt's block is served on the row");
  assert.equal(row.confirmed_at, T0, "confirmed_at stays the instant this server read the receipt");
  const latest = body.latest_checkpoints[0].anchors.find((a) => a.kind === "base") as Record<string, unknown>;
  assert.equal(latest.block_number, 52_638_732, "and on the latest-checkpoint copy of the row");
  for (const a of body.anchors.filter((a) => a.kind !== "base")) assert.equal((a as Record<string, unknown>).block_number, null, "rows with no block serve null, not an absent key");
  assert.match(body.what_an_anchor_proves, /block_number/, "the prose says what block_number is");
  void db;
});

// confirmBase itself against a JSON-RPC node stubbed at fetch.
test("confirmBase_must_return_the_receipt_block_number", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const result = body.method === "eth_getTransactionReceipt"
      ? { transactionHash: hash(7), blockHash: hash(9), blockNumber: "0x3233c8c", transactionIndex: "0x1", from: hash(1).slice(0, 42), to: hash(1).slice(0, 42), cumulativeGasUsed: "0x5208", gasUsed: "0x5208", effectiveGasPrice: "0x1", contractAddress: null, logs: [], logsBloom: "0x" + "00".repeat(256), status: "0x1", type: "0x2" }
      : null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await REAL_DEPS.confirmBase({ BASE_RPC_URL: "https://rpc.invalid" } as Env, hash(7)), { status: "confirmed", block_number: 52_640_908 });
  } finally {
    globalThis.fetch = saved;
  }
});
