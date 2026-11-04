// A Base anchor whose transaction was dropped before inclusion used to stay
// `pending` forever, and the confirmation pass asks for the two OLDEST pending
// rows each pass. Live, rows 11615 and 12297 (hashes Base has no record of)
// held both slots from 2026-10-15, and no later Base row confirmed again, though
// later transactions were mined (row 12301 is in block 52638732). This file
// checks that a dropped row is recorded failed after BASE_DROPPED_MS, that it
// then stops holding a slot, and that only "the node has neither a receipt nor
// the transaction" counts as dropped.
//
// Killing mutations, each checked in a scratch copy:
//   - dropped-stays-pending: the loop's "unknown" branch is a bare `continue`.
//     The dropped rows keep both slots, the mined row never confirms: tests 1
//     and 2 red.
//   - drop-window-ignored: no age check before recording a drop. The
//     30-minute-old unknown row is failed on the first pass: test 2 red.
//   - rpc-error-reads-as-drop: confirmBase treats any receipt error as a
//     missing receipt. A receipt lookup answered with HTTP 500 then reads as
//     dropped when the transaction lookup comes back empty: test 3 red.
//   - mempool-tx-reads-as-drop: confirmBase skips the getTransaction lookup. A
//     transaction still queued at the node reads as dropped: test 3 red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, BASE_DROPPED_MS, OTS_CALENDARS, REAL_DEPS, type AnchorDeps, type BaseReceiptStatus } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const T0 = 1_792_100_000_000;
const KEY = "0x" + "11".repeat(32);
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");

// Checkpoints whose Base, calendar and archive rows already exist (the archive
// row dated T0 keeps its hour gate shut), so the pass sends nothing and only the
// confirmation loop runs.
function fixture(rows: { id: number; sentAgo: number }[]): { env: Env; db: ReturnType<typeof sqliteTestEnv>["db"] } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (const r of rows) db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (${r.id}, 'identity_events', ${r.id}, '${ROOT}', 's', ${T0 - r.sentAgo - 1})`);
  // Base rows at their live ids before any other anchor, so the autoincrement ids of the rest land after them.
  for (const r of rows) db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at) VALUES (${r.id}, ${r.id}, 'base', '${hash(r.id)}', NULL, 'pending', NULL, ${T0 - r.sentAgo}, NULL)`);
  for (const r of rows) {
    for (const cal of OTS_CALENDARS) db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${r.id}, 'ots', '${cal}', 'pending', ${T0 - r.sentAgo})`);
    db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${r.id}, 'archive', 'https://web.archive.org/web/x', 'confirmed', ${T0})`);
  }
  return { env: { ...env, ANCHOR_BASE_KEY: KEY }, db };
}

function deps(byId: Record<number, BaseReceiptStatus>): AnchorDeps {
  return {
    fetch: (async () => new Response("", { status: 500 })) as typeof fetch,
    submitBase: async () => { throw new Error("no send expected"); },
    confirmBase: async (_env, target) => byId[parseInt(target, 16)] ?? "pending",
  };
}

type Row = { id: number; target: string; status: string; error: string | null; confirmed_at: number | null };
const baseRows = (db: ReturnType<typeof sqliteTestEnv>["db"]) =>
  (db.prepare("SELECT id, target, status, error, confirmed_at FROM anchors WHERE kind = 'base' ORDER BY id").all() as Row[]).map((r) => ({ ...r }));

test("two dropped transactions at the head of the queue no longer stop later Base rows confirming", async () => {
  const { env, db } = fixture([{ id: 11615, sentAgo: 9 * 86_400_000 }, { id: 12297, sentAgo: 8 * 86_400_000 }, { id: 12301, sentAgo: 8 * 86_400_000 - 300_000 }]);
  const d = deps({ 11615: "unknown", 12297: "unknown", 12301: "confirmed" });
  for (let pass = 0; pass < 3; pass++) await anchorCheckpoints(env, T0 + pass * 300_000, d);
  const rows = baseRows(db);
  assert.deepEqual(rows.map((r) => [r.id, r.status]), [[11615, "failed"], [12297, "failed"], [12301, "confirmed"]], "the mined row behind two dropped ones confirms");
  for (const r of rows.slice(0, 2)) {
    assert.match(r.error ?? "", /^dropped: Base had no receipt and no transaction for this hash \d+ min after it was sent$/);
    assert.equal(r.target, hash(r.id), "the 0x hash stays, so the row still names what was sent and still blocks a re-send");
    assert.equal(r.confirmed_at, null);
  }
});

test("an unknown transaction younger than BASE_DROPPED_MS stays pending, and is recorded dropped once it is older", async () => {
  const { env, db } = fixture([{ id: 20000, sentAgo: 30 * 60_000 }]);
  const d = deps({ 20000: "unknown" });
  const early = await anchorCheckpoints(env, T0, d);
  assert.equal(early.failed, 0);
  assert.deepEqual(baseRows(db).map((r) => [r.status, r.error]), [["pending", null]], "30 minutes is inside the window");
  const late = await anchorCheckpoints(env, T0 - 30 * 60_000 + BASE_DROPPED_MS, d);
  assert.equal(late.failed, 1);
  assert.deepEqual(baseRows(db).map((r) => [r.status, r.error]), [["failed", "dropped: Base had no receipt and no transaction for this hash 60 min after it was sent"]]);
});

// confirmBase itself, against a JSON-RPC node stubbed at fetch: viem's http
// transport calls the global fetch, so nothing leaves the process.
async function classify(node: (method: string) => Response): Promise<BaseReceiptStatus> {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    const res = node(body.method);
    if (res.status !== 200) return res;
    const { result } = (await res.json()) as { result: unknown };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return await REAL_DEPS.confirmBase({ BASE_RPC_URL: "https://rpc.invalid" } as Env, hash(7));
  } finally {
    globalThis.fetch = saved;
  }
}
const ok = (result: unknown) => new Response(JSON.stringify({ result }), { status: 200 });

test("confirmBase calls a hash dropped only when the node has neither a receipt nor the transaction", async () => {
  assert.equal(await classify(() => ok(null)), "unknown", "no receipt, no transaction");
  assert.equal(await classify((m) => (m === "eth_getTransactionReceipt" ? ok(null) : ok({ hash: hash(7), blockHash: null, blockNumber: null, from: hash(1).slice(0, 42), to: hash(1).slice(0, 42), nonce: "0x1", value: "0x0", gas: "0x5208", input: "0x", type: "0x2", maxFeePerGas: "0x1", maxPriorityFeePerGas: "0x1", chainId: "0x2105", v: "0x0", r: "0x1", s: "0x1", transactionIndex: null }))), "pending", "queued at the node: not dropped");
  assert.equal(await classify(() => new Response("upstream down", { status: 500 })), "pending", "an RPC error says nothing about the transaction");
  assert.equal(
    await classify((m) => (m === "eth_getTransactionReceipt" ? new Response("upstream down", { status: 500 }) : ok(null))),
    "pending",
    "a failed receipt lookup is not a missing receipt, whatever the transaction lookup says",
  );
});
