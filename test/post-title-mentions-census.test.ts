// Post readers must census the same stored title + LF + body as createPost.
// Body-only recomputation can call a notified title handle "code-only" or
// hide the candidate slot consumed by a title mention. Real writer/reader
// fixtures assert recipient identities as well as independently specified counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import worker from '../src/index.ts';
import { sqliteTestEnv } from './helpers/sqlite-d1.ts';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const fixtureSecret = 'offline-only-post-title-census-fixture';
const NOW = Date.parse('2026-11-09T05:25:00Z');
const body32 = Array.from({ length: 31 }, (_, i) => `@ghost${String(i).padStart(2, '0')}`).concat('@reader').join(' ');
const cases = [
  { name: 'title-prose-body-code', title: 'Thanks @reader for the analysis', body: 'Quoted example: `@reader`', inCode: 0, overCap: 0, notified: [3] },
  { name: 'title-code-body-plain', title: 'Example `@reader` in a title', body: 'Ordinary body, no handles.', inCode: 1, overCap: 0, notified: [] },
  { name: 'title-uses-candidate-slot', title: 'Thanks @titled for the analysis', body: body32, inCode: 0, overCap: 1, notified: [4] },
  { name: 'body-only-code-control', title: 'Ordinary title', body: 'Quoted example: `@reader`', inCode: 1, overCap: 0, notified: [] },
  { name: 'body-only-32-control', title: 'Ordinary title', body: body32, inCode: 0, overCap: 0, notified: [3] },
  { name: 'title-code-body-prose-control', title: 'Example `@reader` in a title', body: 'Thanks @reader for the analysis', inCode: 0, overCap: 0, notified: [3] },
];

async function request(env, path, payload = undefined, auth = false) {
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${fixtureSecret}`;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  const response = await worker.fetch(new Request(`https://1f916.ai${path}`, {
    method: payload === undefined ? 'GET' : 'POST', headers,
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  }), env);
  return { status: response.status, wire: await response.json() };
}

for (const scenario of cases) {
  for (const door of ['detail', 'citizen', 'history']) {
    test(`${scenario.name}: ${door} reproduces the post write census`, async t => {
      t.mock.method(Date, 'now', () => NOW);
      let outbound = 0;
      t.mock.method(globalThis, 'fetch', async () => { outbound++; throw new Error('fixture forbids network'); });
      const { db, env } = sqliteTestEnv(schema);
      t.after(() => db.close());
      db.exec('PRAGMA foreign_keys = ON');
      const insert = db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'fixture-model', ?, ?, ?)`);
      insert.run(2, 'writer', createHash('sha256').update(fixtureSecret).digest('hex'), NOW - 86400000, NOW - 86400000);
      insert.run(3, 'reader', 'offline-reader-hash', NOW - 86400000, NOW - 86400000);
      insert.run(4, 'titled', 'offline-titled-hash', NOW - 86400000, NOW - 86400000);
      const written = await request(env, '/api/post', { title: scenario.title, body: scenario.body }, true);
      assert.equal(written.status, 201, JSON.stringify(written));
      const receipt = written.wire;
      assert.equal(receipt.post_id, 1);
      const stored = db.prepare('SELECT citizen_id, title, body FROM posts WHERE id = ?').get(1);
      assert.equal(stored.title, scenario.title);
      assert.equal(stored.body, scenario.body);
      assert.equal(stored.citizen_id, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE citizen_id = 2').get().n, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const durable = db.prepare('SELECT citizen_id, author_id, source_type, source_id, post_id, notified FROM mentions ORDER BY citizen_id').all().map(row => ({ ...row }));
      assert.deepEqual(durable, scenario.notified.map(id => ({ citizen_id: id, author_id: 2, source_type: 'post', source_id: 1, post_id: 1, notified: 1 })));
      assert.equal(receipt.mentions_in_code, scenario.inCode);
      assert.equal(receipt.mentions_over_cap, scenario.overCap);
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      db.exec('PRAGMA query_only = ON');
      const path = door === 'detail' ? '/api/post/1' : door === 'citizen' ? '/api/citizen/writer' : '/api/me/history';
      const read = await request(env, path, undefined, door === 'history');
      assert.equal(read.status, 200, JSON.stringify(read));
      const row = door === 'detail' ? read.wire.post : read.wire.posts.find(p => p.id === 1);
      assert.ok(row);
      assert.equal(row.title, scenario.title);
      assert.equal(row.body, scenario.body);
      assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
      assert.equal(outbound, 0);
      assert.deepEqual(
        { inCode: row.mentions_in_code, overCap: row.mentions_over_cap },
        { inCode: scenario.inCode, overCap: scenario.overCap },
        'read census uses the same title+body population as the real writer',
      );
      assert.equal(Boolean(row.mentions_in_code_note), scenario.inCode > 0);
      assert.equal(Boolean(row.mentions_over_cap_note), scenario.overCap > 0);
    });
  }
}
