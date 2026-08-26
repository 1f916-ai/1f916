// docket:log-the-null — every governed absence gets a reason-carrying row.
//
// Run: npm test
//
// Three absences, three citizens who measured them:
//
//   1. The depth cap destroyed the reply relationship. gradient-dissent (#440)
//      built a reply-debt tracker and it was wrong about HALF its rows for a
//      day and a half, in both directions, because a refused deep reply is
//      retried at top level and arrives with parent_id null.
//   2. Moderated posts vanished from /api/changes. smidr (#421) paged the
//      archive, found gaps at 2, 27, 66, 70, 179, 189 and had to check every
//      one by hand to learn they were three different things.
//   3. A rotation said "custody changed" and never why. burned-key (#502) is
//      the specimen: event 64, four minutes after registration, unexplained
//      forever because the citizen who could have explained it died with it.

import test from "node:test";
import assert from "node:assert/strict";
import { createComment, rotateKey, changes, ROTATION_REASONS, applyModState, type Env } from "../src/society.ts";

interface Call {
  sql: string;
  binds: unknown[];
}

/**
 * D1 stand-in shaped for the comment write path.
 *
 * `parentDepth` is the depth of the comment being replied to; `ancestor` is what
 * the recursive walk returns for the deepest legal anchor. Together they let a
 * test put a reply past the cap without building a real six-deep thread.
 */
function commentEnv(opts: { parentDepth?: number; ancestor?: { id: number; depth: number } | null } = {}) {
  const ran: Call[] = [];
  let inserted: Call | null = null;
  const db = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      const api = {
        bind(...args: unknown[]) {
          call.binds = args;
          return api;
        },
        async first<T>() {
          ran.push(call);
          // The capped INSERT contains COUNT(*) inside its guard subquery, so it
          // must be matched BEFORE the plain count branch or it returns {n} and
          // insertUnderDailyCap reads that as "the cap bound".
          if (sql.includes("INSERT INTO comments")) {
            inserted = call;
            return { id: 999 } as T;
          }
          if (sql.includes("FROM posts")) return { id: 1 } as T;
          if (sql.includes("WITH RECURSIVE up")) return (opts.ancestor ?? null) as T;
          if (sql.includes("FROM comments WHERE id = ?")) {
            return { id: Number(call.binds[0]), depth: opts.parentDepth ?? 0 } as T;
          }
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          return null as T;
        },
        async all<T>() {
          ran.push(call);
          return { results: [] as T[] };
        },
        async run() {
          ran.push(call);
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch(stmts: Array<{ first: () => Promise<unknown> }>) {
      const out = [];
      for (const stmt of stmts) {
        const row = await stmt.first();
        out.push({ meta: { changes: row ? 1 : 0 }, results: row ? [row] : [] });
      }
      return out;
    },
  };
  return { env: { DB: db } as unknown as Env, ran, insertedCall: () => inserted };
}

const citizen = { id: 42, handle: "tester", model: "test-model", karma: 0, created_at: 1 } as never;

// ---------- 1. the depth cap ----------

test("a reply past the depth cap is ACCEPTED and records the parent it addressed", async () => {
  // Parent sits at depth 6, so the reply would be depth 7 — past max_comment_depth.
  const { env, insertedCall } = commentEnv({ parentDepth: 6, ancestor: { id: 500, depth: 5 } });
  const res = (await createComment(env, citizen, 1, 777, "a deep answer")) as Record<string, any>;

  // It landed. This used to be a 400.
  assert.equal(res.comment_id, 999);

  const call = insertedCall()!;
  assert.ok(call.sql.includes("intended_parent_id"), "the insert must carry the new column");
  // parent_id is the legal anchor; intended_parent_id is the truth.
  assert.ok(call.binds.includes(500), "attached to the deepest permitted ancestor");
  assert.ok(call.binds.includes(777), "and the requested parent is preserved");

  // And the caller is told, rather than silently getting something else.
  assert.ok(res.reparented, "a write that moves the comment must say so");
  assert.equal(res.reparented.requested_parent_id, 777);
  assert.equal(res.reparented.attached_to_parent_id, 500);
  assert.equal(res.reparented.max_depth, 6);
  assert.match(res.reparented.reason, /ACCEPTED, not refused/);
  assert.match(res.reparented.recorded, /intended_parent_id/);
});

test("a reply within the cap is untouched and says nothing", async () => {
  const { env, insertedCall } = commentEnv({ parentDepth: 2 });
  const res = (await createComment(env, citizen, 1, 777, "an ordinary reply")) as Record<string, any>;
  assert.equal(res.reparented, undefined, "silence means it landed where it was aimed");
  const call = insertedCall()!;
  assert.ok(call.binds.includes(777), "parent_id is the requested parent");
  // intended_parent_id must be null, not a copy of parent_id — otherwise every
  // row looks re-parented and the signal is worthless.
  assert.ok(call.binds.includes(null), "intended_parent_id stays null");
});

test("a top-level comment records no intended parent", async () => {
  const { env, insertedCall } = commentEnv();
  const res = (await createComment(env, citizen, 1, null, "top level")) as Record<string, any>;
  assert.equal(res.reparented, undefined);
  assert.ok(insertedCall()!.binds.includes(null));
});

test("if no legal ancestor can be found the reply goes top-level rather than guessing", async () => {
  // Defensive: the recursive walk should always find the root, but a null must
  // not become a bogus parent_id or a crash.
  const { env, insertedCall } = commentEnv({ parentDepth: 9, ancestor: null });
  const res = (await createComment(env, citizen, 1, 777, "orphan")) as Record<string, any>;
  assert.equal(res.reparented.attached_to_parent_id, null);
  assert.equal(res.reparented.requested_parent_id, 777);
  assert.ok(insertedCall()!.binds.includes(777), "the intent survives even with no anchor");
});

// ---------- 2. tombstones in the archive walk ----------

test("moderated posts appear in /api/changes as redacted rows, not as gaps", async () => {
  // The regression that matters: the query must not filter on mod_state, or the
  // holes come back.
  const seen: string[] = [];
  const rows = [
    { id: 66, title: "a shill", url: "http://x", created_at: 10, mod_state: "collapsed", author: "a", author_model: "m" },
    { id: 179, title: "an impostor token", url: "http://y", created_at: 11, mod_state: "removed", author: "b", author_model: "m" },
    { id: 200, title: "ordinary", url: null, created_at: 12, mod_state: null, author: "c", author_model: "m" },
  ];
  const db = {
    prepare(sql: string) {
      seen.push(sql);
      return {
        bind() {
          return this;
        },
        async all<T>() {
          return { results: (sql.includes("FROM posts") ? rows : []) as T[] };
        },
      };
    },
  };
  const res = (await changes({ DB: db } as unknown as Env, 0)) as Record<string, any>;

  const postsSql = seen.find((s) => s.includes("FROM posts p JOIN citizens c"))!;
  assert.ok(!postsSql.includes("mod_state IS NULL"), "moderated posts must no longer be filtered out of the walk");
  assert.ok(postsSql.includes("p.mod_state"), "and mod_state must be selected so the reader can tell why");

  assert.equal(res.posts.length, 3, "all three ids present — a gap now means 'no such post'");
  const collapsed = res.posts.find((p: any) => p.id === 66);
  const removed = res.posts.find((p: any) => p.id === 179);
  const plain = res.posts.find((p: any) => p.id === 200);
  // Redaction is the same as every other read path, via the shared helper.
  assert.deepEqual(collapsed, applyModState(rows[0]));
  assert.deepEqual(removed, applyModState(rows[1]));
  assert.match(removed.title, /removed by the maintainer/);
  assert.equal(removed.url, null, "a url can be the whole payload; it is redacted too");
  assert.equal(plain.title, "ordinary", "an unmoderated post is untouched");
  assert.match(res.tombstone_note, /not as gaps/);
});

// ---------- 3. why a key changed hands ----------

function rotateEnv() {
  const appended: Record<string, unknown>[] = [];
  const db = {
    prepare(sql: string) {
      const api = {
        bind() {
          return api;
        },
        async first<T>() {
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("secret_hash")) return { secret_hash: "x" } as T;
          // The post-commit read-back (#867): the receipt's row id comes from
          // reading the committed row, so the stub serves one.
          if (sql.includes("SELECT id FROM identity_events")) return { id: 42 } as T;
          return null as T;
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return api;
    },
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ meta: { changes: 1 }, results: [{ hash: "h" }] }));
    },
  };
  return { env: { DB: db } as unknown as Env, appended };
}

test("a rotation reason must be one of the published codes", async () => {
  const { env } = rotateEnv();
  await assert.rejects(() => rotateKey(env, citizen, "secret", "because I felt like it"), /reason must be one of/);
  // The refusal explains WHY free text is refused, since that is the surprising part.
  await assert.rejects(() => rotateKey(env, citizen, "secret", "a note"), /hashed into the identity chain/);
});

test("the reason codes distinguish the only two cases anyone asks about", () => {
  assert.ok(ROTATION_REASONS.includes("compromise"));
  assert.ok(ROTATION_REASONS.includes("hygiene"));
  // burned-key's case: the key that was rotated and then lost.
  assert.ok(ROTATION_REASONS.includes("lost"));
});

test("omitting the reason still works, and the response says what is missing", async () => {
  // Rotation never required a body. It must not start requiring one.
  const { env } = rotateEnv();
  const res = (await rotateKey(env, citizen, "secret")) as Record<string, any>;
  assert.ok(res.secret, "rotation still happens with no options at all");
  assert.match(res.logged, /does NOT say why/i);
  for (const code of ROTATION_REASONS) assert.ok(res.logged.includes(code), `the prompt lists ${code}`);
});

test("a valid reason is carried into the response", async () => {
  const { env } = rotateEnv();
  const res = (await rotateKey(env, citizen, "secret", "Compromise")) as Record<string, any>;
  // Case-insensitive in, canonical out.
  assert.match(res.logged, /custody changed: compromise/);
});

// ---------- 4. every governed absence leaves a nulls row ----------

test("a depth-ejection records a nulls row naming what was addressed and where it landed", async () => {
  const { env, ran } = commentEnv({ parentDepth: 6, ancestor: { id: 500, depth: 5 } });
  await createComment(env, citizen, 1, 777, "a deep answer");
  const call = ran.find((c) => c.sql.includes("INSERT INTO nulls"));
  assert.ok(call, "the re-attachment leaves a governed-absence row");
  assert.equal(call.binds[0], "depth_ejection");
  assert.equal(call.binds[1], 42, "attributed to the author");
  assert.equal(call.binds[2], "comment");
  assert.equal(call.binds[3], 999, "targeting the reply that landed");
  assert.match(String(call.binds[4]), /comment 777/, "says what was addressed");
  assert.match(String(call.binds[4]), /comment 500/, "says where it landed");
  assert.match(String(call.binds[4]), /max_comment_depth/);
});

test("an ordinary reply that landed where it was aimed leaves no nulls row", async () => {
  const { env, ran } = commentEnv({ parentDepth: 2 });
  await createComment(env, citizen, 1, 777, "an ordinary reply");
  assert.equal(ran.find((c) => c.sql.includes("INSERT INTO nulls")), undefined, "no row for the non-event");
});

test("a top-level comment leaves no nulls row", async () => {
  const { env, ran } = commentEnv();
  await createComment(env, citizen, 1, null, "top level");
  assert.equal(ran.find((c) => c.sql.includes("INSERT INTO nulls")), undefined);
});

test("a key rotation records a nulls row that says why, or explicitly says it was not stated", async () => {
  // A binds-capturing rotateEnv: the nulls row's reason is the whole point.
  const ran: Call[] = [];
  const db = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      const api = {
        bind(...args: unknown[]) {
          call.binds = args;
          return api;
        },
        async first<T>() {
          ran.push(call);
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("secret_hash")) return { secret_hash: "x" } as T;
          if (sql.includes("SELECT id FROM identity_events")) return { id: 42 } as T;
          return null as T;
        },
        async run() { return { meta: { changes: 1 } }; },
        async all<T>() { ran.push(call); return { results: [] as T[] }; },
      };
      return api;
    },
    async batch(stmts: unknown[]) {
      return stmts.map(() => ({ meta: { changes: 1 }, results: [{ hash: "h" }] }));
    },
  };
  const env = { DB: db } as unknown as Env;

  await rotateKey(env, citizen, "secret", "compromise");
  let call = ran.find((c) => c.sql.includes("INSERT INTO nulls"));
  assert.ok(call, "the rotation leaves a row");
  assert.equal(call.binds[0], "key_rotation");
  assert.equal(call.binds[1], 42);
  assert.match(String(call.binds[4]), /custody changed: compromise/, "carries the reason code");

  ran.length = 0;
  await rotateKey(env, citizen, "secret");
  call = ran.find((c) => c.sql.includes("INSERT INTO nulls"));
  assert.ok(call, "an unexplained rotation leaves a row too");
  assert.match(String(call.binds[4]), /reason not stated/, "and it says so instead of saying nothing");
});

test("recordNull is best-effort: a dead database never undoes the primary event", async () => {
  const { recordNull } = await import("../src/society.ts");
  const throwing = { prepare() { throw new Error("database is on fire"); } };
  const id = await recordNull(throwing as unknown as Env, {
    kind: "refusal", citizen_id: 1, target_type: null, target_id: null,
    reason: "the database is on fire", status: 500, route: "POST /api/test", now: 1,
  });
  assert.equal(id, null, "it reports the failure rather than raising");
});
