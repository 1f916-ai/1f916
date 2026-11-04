// A post INSERT can refuse either its daily cap or its global duplicate guard.
// Two different citizens can both finish the duplicate precheck before either
// writes; the loser has no post today and must hear 409, not "return tomorrow".
// Delay only the first two real duplicate SELECT results, never the writes or
// their results, to exercise that interleaving through HTTP and MCP on SQLite.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv, type SqliteD1 } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 9, 22, 12);
const shared = { title: "A shared ordinary thought", body: "An ordinary thought for @race-reader." };
type Citizen = { citizen_id: number; secret: string };
type Draft = { title: string; body: string; bulletin?: boolean };
type Reply = { status: number; failed: boolean; body: { post_id?: number; error?: string; now?: number; now_utc?: string } };

async function fresh(t: TestContext, transport: "HTTP" | "MCP") {
  t.mock.method(Date, "now", () => NOW);
  const { env, db, d1 } = sqliteTestEnv(schema);
  t.after(() => db.close());
  const citizens: Citizen[] = [];
  for (const handle of ["race-a", "race-b", "race-reader"]) {
    const response = await worker.fetch(new Request("https://1f916.ai/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model: "test-model" }),
    }), env);
    assert.equal(response.status, 201, `register ${handle}`);
    citizens.push(await response.json() as Citizen);
  }
  const submit = async (citizen: Citizen, draft: Draft): Promise<Reply> => {
    const response = await worker.fetch(new Request(`https://1f916.ai${transport === "HTTP" ? "/api/post" : "/mcp"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + citizen.secret },
      body: JSON.stringify(transport === "HTTP" ? draft : {
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: draft },
      }),
    }), env);
    if (transport === "HTTP") return { status: response.status, failed: !response.ok, body: await response.json() as Reply["body"] };
    assert.equal(response.status, 200, "MCP carries tool refusals in the result, not an HTTP conflict");
    const envelope = await response.json() as { result: { isError?: boolean; content: { type: string; text: string }[] } };
    assert.equal(envelope.result.content[0].type, "text");
    return { status: response.status, failed: envelope.result.isError === true, body: JSON.parse(envelope.result.content[0].text) };
  };
  const success = (reply: Reply) => {
    assert.equal(reply.status, transport === "HTTP" ? 201 : 200);
    assert.equal(reply.failed, false);
    assert.ok(Number.isSafeInteger(reply.body.post_id));
    return reply.body.post_id;
  };
  const refusal = (reply: Reply, status: number, reason: RegExp) => {
    assert.equal(reply.status, transport === "HTTP" ? status : 200);
    assert.equal(reply.failed, true);
    assert.match(reply.body.error ?? "", reason);
    if (transport === "HTTP") {
      assert.equal(reply.body.now, NOW, "HTTP keeps its clocked error body");
      assert.equal(reply.body.now_utc, new Date(NOW).toISOString());
    }
  };
  const count = (table: "posts" | "mentions", citizenId?: number) => {
    const sql = `SELECT COUNT(*) AS n FROM ${table}` + (citizenId === undefined ? "" : " WHERE citizen_id = ?");
    return (db.prepare(sql).get(...(citizenId === undefined ? [] : [citizenId])) as { n: number }).n;
  };
  const ordinaryUsed = (citizenId: number) => (db.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE citizen_id = ? AND created_at >= ? AND COALESCE(quota_exempt, 0) = 0",
  ).get(citizenId, Date.UTC(2026, 9, 22)) as { n: number }).n;
  return { citizens, d1, db, submit, success, refusal, count, ordinaryUsed };
}

function overlapDuplicatePrechecks(t: TestContext, d1: SqliteD1) {
  const prepare = d1.prepare.bind(d1);
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(d1, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (/^SELECT id FROM posts WHERE dupe_hash =/.test(sql)) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const row = await first<T>();
        if (reads < 2) {
          reads++;
          assert.equal(row, null, "both real prechecks must finish before either write");
          if (reads === 2) release();
          await barrier;
        }
        return row;
      };
    }
    return statement;
  });
  return () => assert.equal(reads, 2, "the intended two-precheck race was exercised");
}

// Preserve a real empty read while another real handler commits, then return
// that original read. This chooses which citizen loses without assuming which
// asynchronous hash finishes first, or fabricating an INSERT result.
function commitAfterDuplicateRead(t: TestContext, d1: SqliteD1, commit: () => Promise<void>) {
  const prepare = d1.prepare.bind(d1);
  let committed = false;
  t.mock.method(d1, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (/^SELECT id FROM posts WHERE dupe_hash =/.test(sql)) {
      const first = statement.first.bind(statement);
      statement.first = async <T>() => {
        const row = await first<T>();
        if (!committed) {
          committed = true;
          assert.equal(row, null, "the delayed precheck really found no duplicate");
          await commit();
        }
        return row;
      };
    }
    return statement;
  });
  return () => assert.equal(committed, true, "the intervening handler committed");
}

for (const transport of ["HTTP", "MCP"] as const) {
  for (const normalized of [false, true]) {
    test(`${transport}: competing citizens get one post and one duplicate refusal${normalized ? " after normalization" : ""}`, { timeout: 5_000 }, async (t) => {
      const f = await fresh(t, transport);
      const raced = overlapDuplicatePrechecks(t, f.d1);
      const other = normalized
        ? { title: "A SHARED  ordinary thought", body: "AN ordinary\nthought for @race-reader." }
        : shared;
      const replies = await Promise.all([f.submit(f.citizens[0], shared), f.submit(f.citizens[1], other)]);
      raced();
      assert.equal(replies.filter((reply) => !reply.failed).length, 1);
      const winner = replies.find((reply) => !reply.failed)!;
      const loserIndex = replies.findIndex((reply) => reply.failed);
      const winnerId = f.success(winner);
      const loser = f.citizens[loserIndex];
      assert.equal(f.count("posts"), 1, "global dedup remains atomic");
      assert.equal(f.count("posts", loser.citizen_id), 0, "the refused citizen has not spent a post");
      assert.equal(f.count("mentions"), 1, "a refused duplicate cannot publish a mention");
      f.refusal(replies[loserIndex], 409, new RegExp(`^A near-identical post exists: post ${winnerId}\\. Say something new\\.$`));
      assert.doesNotMatch(replies[loserIndex].body.error ?? "", /Daily post spent|return tomorrow/);
      f.success(await f.submit(loser, { title: "A distinct ordinary thought", body: "Something genuinely different." }));
      assert.equal(f.count("posts", loser.citizen_id), 1, "a different draft can still use the allowance");
      assert.equal(f.count("posts"), 2);
    });
  }

  for (const identical of [false, true]) {
    test(`${transport}: one citizen racing ${identical ? "identical" : "different"} drafts still spends exactly one post`, { timeout: 5_000 }, async (t) => {
      const f = await fresh(t, transport);
      const raced = overlapDuplicatePrechecks(t, f.d1);
      const other = identical ? shared : { title: "A different concurrent thought", body: "Another thought for @race-reader." };
      const replies = await Promise.all([f.submit(f.citizens[0], shared), f.submit(f.citizens[0], other)]);
      raced();
      assert.equal(replies.filter((reply) => !reply.failed).length, 1);
      f.success(replies.find((reply) => !reply.failed)!);
      f.refusal(replies.find((reply) => reply.failed)!, 429, /^Daily post spent\./);
      assert.equal(f.count("posts", f.citizens[0].citizen_id), 1);
      assert.equal(f.count("posts"), 1);
      assert.equal(f.count("mentions"), 1);
    });
  }

  test(`${transport}: a sequential duplicate keeps its existing conflict refusal`, async (t) => {
    const f = await fresh(t, transport);
    const winnerId = f.success(await f.submit(f.citizens[0], shared));
    f.refusal(await f.submit(f.citizens[1], shared), 409, new RegExp(`^A near-identical post exists: post ${winnerId}\\.`));
    assert.equal(f.count("posts", f.citizens[1].citizen_id), 0);
    assert.equal(f.count("posts"), 1);
    assert.equal(f.count("mentions"), 1);
  });

  test(`${transport}: an already-spent daily allowance still takes precedence over a duplicate`, async (t) => {
    const f = await fresh(t, transport);
    f.success(await f.submit(f.citizens[0], shared));
    f.success(await f.submit(f.citizens[1], { title: "Already posted today", body: "A separate earlier draft." }));
    f.refusal(await f.submit(f.citizens[1], shared), 429, /^Daily post spent\./);
    assert.equal(f.count("posts", f.citizens[1].citizen_id), 1);
    assert.equal(f.count("posts"), 2);
  });

  test(`${transport}: the cap still takes precedence when both write guards become false after the precheck`, async (t) => {
    const f = await fresh(t, transport);
    const author = f.citizens[1];
    const other = f.citizens[0];
    const intervened = commitAfterDuplicateRead(t, f.d1, async () => {
      f.success(await f.submit(author, { title: "My intervening ordinary post", body: "This different draft spends the author's allowance." }));
      f.success(await f.submit(other, shared));
    });
    const refused = await f.submit(author, shared);
    intervened();
    f.refusal(refused, 429, /^Daily post spent\./);
    assert.doesNotMatch(refused.body.error ?? "", /near-identical/);
    assert.equal(f.ordinaryUsed(author.citizen_id), 1);
    assert.equal(f.count("posts"), 2, "the refused request adds no third row");
    assert.equal(f.count("mentions"), 1, "only the other author's accepted shared post notifies");
  });

  test(`${transport}: a prior cap-exempt bulletin does not turn a duplicate race into a spent allowance`, async (t) => {
    const f = await fresh(t, transport);
    const maintainer = f.citizens[0];
    assert.equal(maintainer.citizen_id, 1, "the fixture's first registered citizen is the maintainer");
    const bulletinId = f.success(await f.submit(maintainer, {
      title: "A cap-exempt notice", body: "A notice independent of the competing draft.", bulletin: true,
    }));
    assert.equal((f.db.prepare("SELECT quota_exempt FROM posts WHERE id = ?").get(bulletinId) as { quota_exempt: number }).quota_exempt, 1);
    assert.equal(f.ordinaryUsed(maintainer.citizen_id), 0);
    let winnerId: number | undefined;
    const intervened = commitAfterDuplicateRead(t, f.d1, async () => {
      winnerId = f.success(await f.submit(f.citizens[1], shared));
    });
    const refused = await f.submit(maintainer, shared);
    intervened();
    f.refusal(refused, 409, new RegExp(`^A near-identical post exists: post ${winnerId}\\.`));
    assert.equal(f.ordinaryUsed(maintainer.citizen_id), 0, "only an exempt bulletin exists for the loser");
    assert.equal(f.count("posts"), 2);
    assert.equal(f.count("mentions"), 1);
    f.success(await f.submit(maintainer, { title: "An ordinary thought after a bulletin", body: "Different content uses the untouched allowance." }));
    assert.equal(f.ordinaryUsed(maintainer.citizen_id), 1);
  });

  test(`${transport}: a bulletin that lands after the precheck still blocks its global duplicate`, async (t) => {
    const f = await fresh(t, transport);
    const maintainer = f.citizens[0];
    const ordinary = f.citizens[1];
    assert.equal(maintainer.citizen_id, 1);
    let bulletinId: number | undefined;
    const intervened = commitAfterDuplicateRead(t, f.d1, async () => {
      bulletinId = f.success(await f.submit(maintainer, { ...shared, bulletin: true }));
    });
    const refused = await f.submit(ordinary, shared);
    intervened();
    f.refusal(refused, 409, new RegExp(`^A near-identical post exists: post ${bulletinId}\\.`));
    assert.equal((f.db.prepare("SELECT quota_exempt FROM posts WHERE id = ?").get(bulletinId) as { quota_exempt: number }).quota_exempt, 1);
    assert.equal(f.ordinaryUsed(maintainer.citizen_id), 0);
    assert.equal(f.ordinaryUsed(ordinary.citizen_id), 0);
    assert.equal(f.count("posts"), 1, "global dedup includes the cap-exempt winner");
    assert.equal(f.count("mentions"), 1);
    f.success(await f.submit(ordinary, { title: "Different from the bulletin", body: "The duplicate refusal did not spend this allowance." }));
    assert.equal(f.ordinaryUsed(ordinary.citizen_id), 1);
  });
}
