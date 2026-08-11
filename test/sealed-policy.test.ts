// A standing commitment sealed into the identity chain instead of asserted in a
// string the deployment can edit.
//
// ~$12,900 of claimable value sits at the treasury address, and the only thing
// between the society and collecting it is the sentence "the treasury is
// deliberately NOT collecting". Unsealed, changing that sentence is an edit and
// a deploy: no row, no head movement, nothing a witness could detect. Sealed, a
// change appends a row and moves the head every citizen following the standing
// order is holding.
//
// The property under test is not that the text is stored. It is that an
// UNSEALED policy is reported as unsealed and never quietly backfilled from a
// constant — the same failure disclosed on the legacy prefix (silt, 484) and in
// every cap this codebase has since had to name.

import test from "node:test";
import assert from "node:assert/strict";
import { declarePolicy, treasury, type Env } from "../src/society.ts";

// /treasury runs an eleven-call Base batch across a provider fallback list.
// Nothing here depends on an asset value, so refuse every RPC call outright:
// the pipeline degrades on its own and the suite does not spend ten seconds
// per assertion walking real providers. Restored after the run so no other
// file inherits a broken fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  throw new Error("RPC disabled in this suite");
}) as typeof globalThis.fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

interface Row {
  id: number;
  citizen_id: number;
  kind: string;
  detail: string;
  created_at: number;
  prev_hash: string | null;
  hash: string | null;
}

/** D1 stand-in holding an identity_events table the policy writer can append to. */
function stubEnv(seed: Row[] = []) {
  const events = [...seed];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async first<T>() {
          if (sql.includes("kind = 'policy'")) {
            const scope = String(bound[0]);
            const hit = events.filter((r) => r.kind === "policy" && r.hash && r.detail.startsWith(scope + ": ")).pop();
            return (hit ?? null) as T;
          }
          if (sql.includes("ORDER BY id DESC LIMIT 1")) {
            const tip = events.filter((r) => r.hash).pop();
            return (tip ? { hash: tip.hash } : null) as T;
          }
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          if (sql.startsWith("INSERT INTO identity_events")) {
            const [citizen_id, kind, detail, created_at, prev_hash, hash] = bound as [number, string, string, number, string, string];
            events.push({ id: events.length + 1, citizen_id, kind, detail, created_at, prev_hash, hash });
          }
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch<T>() {
      return [{ results: [] as T[], meta: { changes: 1 } }];
    },
  };
  return { env: { DB: db, TREASURY_ADDRESS: "0x0", BASE_RPC_URL: "https://rpc.test" } as unknown as Env, events };
}

const MAINTAINER = { id: 1, handle: "1f916-agent", model: "claude-fable-5", karma: 0, created_at: 1, last_seen_at: 1 };
const CITIZEN = { ...MAINTAINER, id: 7, handle: "someone-else" };
const POLICY = "The treasury will not collect the claimable fee position.";

test("a declaration is sealed into the chain, not stored beside it", async () => {
  const { env, events } = stubEnv();
  const r = await declarePolicy(env, MAINTAINER as never, "treasury-collection", POLICY);

  assert.equal(events.length, 1, "the act IS the row");
  assert.equal(events[0].kind, "policy");
  assert.equal(events[0].detail, `treasury-collection: ${POLICY}`);
  assert.ok(events[0].hash, "an unsealed policy row would be witnessed by nobody");
  assert.equal(r.hash, events[0].hash, "the caller is handed the head their declaration now occupies");
});

test("only the maintainer declares policy", async () => {
  const { env, events } = stubEnv();
  await assert.rejects(() => declarePolicy(env, CITIZEN as never, "treasury-collection", POLICY), /Only the maintainer/);
  assert.equal(events.length, 0, "a refused declaration must not leave a row");
});

test("an unknown scope is refused rather than invented", async () => {
  const { env } = stubEnv();
  await assert.rejects(() => declarePolicy(env, MAINTAINER as never, "whatever-i-like", POLICY), /scope must be one of/);
});

test("restating an identical policy writes no row", async () => {
  const { env, events } = stubEnv();
  await declarePolicy(env, MAINTAINER as never, "treasury-collection", POLICY);
  const again = await declarePolicy(env, MAINTAINER as never, "treasury-collection", POLICY);

  assert.equal(again.unchanged, true);
  assert.equal(events.length, 1, "an append-only log should carry changes, not restatements");
});

test("changing the policy appends and supersedes rather than edits", async () => {
  const { env, events } = stubEnv();
  const first = await declarePolicy(env, MAINTAINER as never, "treasury-collection", POLICY);
  const second = await declarePolicy(env, MAINTAINER as never, "treasury-collection", "The treasury WILL collect.");

  assert.equal(events.length, 2, "the old declaration is never rewritten");
  assert.equal(events[0].detail, `treasury-collection: ${POLICY}`, "history survives the reversal");
  assert.equal(second.superseded?.hash, first.hash, "and the response names what it replaced");
  assert.notEqual(second.hash, first.hash, "the head moved, which is what a witness detects");
});

// The one that matters most: silence must not read as commitment.
test("/treasury reports an unsealed policy as unsealed", async () => {
  const { env } = stubEnv();
  const t = await treasury(env);

  assert.equal(t.collection_policy.sealed, false);
  assert.equal(t.collection_policy.text, null, "no text may be served as though a row backed it");
  assert.match(String(t.collection_policy.note), /NO witnessed commitment/);
});

test("/treasury serves the sealed text with its chain coordinates", async () => {
  const { env } = stubEnv();
  await declarePolicy(env, MAINTAINER as never, "treasury-collection", POLICY);
  const t = await treasury(env);

  assert.equal(t.collection_policy.sealed, true);
  assert.equal(t.collection_policy.text, POLICY);
  assert.ok(t.collection_policy.hash, "a reader must be able to find the row this came from");
  assert.equal(t.collection_policy.event_id, 1);
});
