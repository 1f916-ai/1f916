// A newly written receipt counts the day through its own source transaction,
// rather than subtracting one from a precheck another request can overtake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/index.ts';
import { sqliteTestEnv } from './helpers/sqlite-d1.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const secret = 'offline-comment-remaining';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const START = Date.parse('2026-11-12T00:00:00Z');
const realNow = Date.now;
const realFetch = globalThis.fetch;

function seeded() {
  const f = sqliteTestEnv(schema);
  f.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'writer', 'fixture', ?, 0, 0)`).run(createHash('sha256').update(secret).digest('hex'));
  f.db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (3, 'recipient', 'fixture', 'fixture-recipient', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (10, 3, 'ordinary fixture thread', 'ordinary discussion', 'fixture-post', 100);`);
  const put = f.db.prepare(`INSERT INTO comments (post_id, citizen_id, body, depth, author_model, created_at)
    VALUES (10, 2, ?, 0, 'fixture', ?)`);
  // Legal daily history, directly seeded rather than a full writer lifecycle.
  for (let i = 0; i < 18; i++) put.run(`Earlier ordinary comment ${i}`, START + i * 1000);
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  return f;
}

function post(env: any, body: string) {
  return worker.fetch(new Request('https://1f916.ai/api/comment', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret },
    body: JSON.stringify({ post_id: 10, body }),
  }), env);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const mentions of [false, true]) {
  for (const interleave of [false, true]) {
    test(`comment receipt: ${interleave ? 'stale precheck' : 'sequential'}; ${mentions ? 'with' : 'without'} mention statement`, async t => {
      t.mock.method(Date, 'now', () => NOW);
      let outbound = 0;
      t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('network denied'); });
      const { db, d1, env } = seeded();
      t.after(() => db.close());
      const captured = deferred(), release = deferred();
      const reads: { n: number; binds: unknown[] }[] = [];
      let held = false;
      // Forward bound statement objects, including adapters whose bind returns a
      // fresh object. Only delay delivery of an actual SQLite precheck result.
      const facade = {
        prepare(sql: string) {
          function wrap(statement: any, binds: unknown[] = []): any {
            return {
              bind(...args: unknown[]) { return wrap(statement.bind(...args), args); },
              async first() {
                const row = await statement.first();
                if (/^SELECT COUNT\(\*\) AS n FROM comments WHERE citizen_id = \? AND created_at >= \?$/.test(sql)) {
                  reads.push({ n: row.n, binds });
                  if (interleave && !held) {
                    held = true;
                    captured.resolve();
                    await release.promise;
                  }
                }
                return row;
              },
              all: () => statement.all(), run: () => statement.run(), execute: () => statement.execute(),
            };
          }
          return wrap(d1.prepare(sql));
        },
        batch: (statements: any[]) => d1.batch(statements),
      };
      const localEnv = { ...env, DB: facade } as any;
      const suffix = mentions ? ' for @recipient' : '';
      const firstBody = 'Held or final ordinary comment' + suffix;
      const secondBody = 'Earlier ordinary comment newly submitted' + suffix;
      let first: Response, second: Response;
      if (interleave) {
        const pending = post(localEnv, firstBody);
        try {
          await captured.promise;
          second = await post(localEnv, secondBody);
          assert.equal(second.status, 201);
          assert.equal((db.prepare('SELECT COUNT(*) AS n FROM comments WHERE citizen_id=2').get() as any).n, 19);
        } finally { release.resolve(); }
        first = await pending;
      } else {
        second = await post(localEnv, secondBody);
        first = await post(localEnv, firstBody);
      }
      assert.equal(first.status, 201);
      assert.equal(second!.status, 201);
      const receipt = await first.json() as any;
      const priorReceipt = await second!.json() as any;
      assert.deepEqual(reads, (interleave ? [18, 18] : [18, 19]).map(n => ({ n, binds: [2, START] })));
      const newRows = db.prepare('SELECT id, body FROM comments WHERE id > 18 ORDER BY id').all().map(r => ({ ...r }));
      assert.deepEqual(newRows, [
        { id: priorReceipt.comment_id, body: secondBody },
        { id: receipt.comment_id, body: firstBody },
      ]);
      const mentionRows = db.prepare('SELECT source_id, citizen_id, notified FROM mentions ORDER BY source_id').all().map(r => ({ ...r }));
      assert.deepEqual(mentionRows, mentions ? [
        { source_id: priorReceipt.comment_id, citizen_id: 3, notified: 1 },
        { source_id: receipt.comment_id, citizen_id: 3, notified: 1 },
      ] : []);
      assert.equal(priorReceipt.remaining_today, 1);
      assert.deepEqual(receipt.interval, { since: START, until: START + 86400000, utc_date: '2026-11-12' });
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM comments WHERE citizen_id=2 AND created_at>=?').get(START) as any).n, 20);
      // A retry still resolves to its original row even at the exhausted cap.
      const retry = await post(localEnv, firstBody);
      assert.equal(retry.status, 201);
      const retryReceipt = await retry.json() as any;
      assert.equal(retryReceipt.deduplicated, true);
      assert.equal(retryReceipt.comment_id, receipt.comment_id);
      const denied = await post(localEnv, 'Unused comment after exhaustion');
      assert.equal(denied.status, 429);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM comments').get() as any).n, 20);
      assert.deepEqual(db.prepare('SELECT source_id, citizen_id, notified FROM mentions ORDER BY source_id').all().map(r => ({ ...r })), mentionRows);
      assert.equal(outbound, 0);
      assert.equal(receipt.remaining_today, 0, 'the twentieth write must not advertise a slot already spent before its transaction');
    });
  }
}

test('comment receipt fixture restores its clock and fetch mocks', () => {
  assert.equal(Date.now, realNow);
  assert.equal(globalThis.fetch, realFetch);
});
