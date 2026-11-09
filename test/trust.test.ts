// Trusted karma (src/trust.ts): a pod of accounts voting for each other gains nothing;
// votes from established citizens count. Each test names the mutation that turns it red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedKarma, PER_VOTER_CAP, type VoteEdge } from "../src/trust.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9);

// A small society: 12 established citizens (90 days old) who all vote for each other a
// little, so each of them is a seed (voted for by 11 different citizens).
function society() {
  const born = new Map<number, number>();
  const edges: VoteEdge[] = [];
  for (let i = 1; i <= 12; i++) born.set(i, NOW - 90 * DAY);
  for (let a = 1; a <= 12; a++) for (let b = 1; b <= 12; b++) if (a !== b) edges.push({ voter: a, author: b, n: 1, first: NOW - 40 * DAY });
  return { born, edges };
}

test("a pod voting only for each other gets no trusted karma, however much it votes", () => {
  // Kill: start trust everywhere (uniform PageRank) instead of only at the seeds.
  const { born, edges } = society();
  const pod = [101, 102, 103, 104, 105];
  for (const p of pod) born.set(p, NOW - 45 * DAY);
  for (const a of pod) for (const b of pod) if (a !== b) edges.push({ voter: a, author: b, n: 30, first: NOW - 10 * DAY });
  const tk = trustedKarma(edges, born, NOW);
  for (const p of pod) assert.equal(tk.get(p) ?? 0, 0, `pod member ${p}`);
  assert.ok((tk.get(1) ?? 0) > 0, "an established citizen still has trusted karma");
});

test("votes from established citizens count", () => {
  // Kill: return an empty map, or drop the seeds' votes.
  const { born, edges } = society();
  born.set(200, NOW - 40 * DAY);
  for (let v = 1; v <= 5; v++) edges.push({ voter: v, author: 200, n: 2, first: NOW - 5 * DAY });
  const tk = trustedKarma(edges, born, NOW);
  assert.ok((tk.get(200) ?? 0) > 0.5, `got ${tk.get(200)}`);
});

test("a voter under 30 days old when it voted doesn't count", () => {
  // Kill: drop the VOTER_MIN_AGE_DAYS check.
  const { born, edges } = society();
  born.set(300, NOW - 40 * DAY);
  born.set(301, NOW - 10 * DAY); // a young account
  edges.push({ voter: 1, author: 301, n: 1, first: NOW - 5 * DAY }); // so it has some trust
  edges.push({ voter: 301, author: 300, n: 3, first: NOW - 2 * DAY });
  const tk = trustedKarma(edges, born, NOW);
  assert.equal(tk.get(300) ?? 0, 0);
});

test("at most 3 votes from one voter count", () => {
  // Kill: use e.n instead of min(PER_VOTER_CAP, e.n) in the final sum.
  const { born, edges } = society();
  born.set(400, NOW - 40 * DAY); born.set(401, NOW - 40 * DAY);
  edges.push({ voter: 1, author: 400, n: 3, first: NOW - 5 * DAY });
  edges.push({ voter: 1, author: 401, n: 300, first: NOW - 5 * DAY });
  const tk = trustedKarma(edges, born, NOW);
  // Voter 1's weight to 401 is capped like its weight to 400, so each gets the same karma from it.
  assert.ok(Math.abs((tk.get(401) ?? 0) - (tk.get(400) ?? 0)) < 1e-9, `${tk.get(400)} vs ${tk.get(401)}`);
  assert.ok((tk.get(401) ?? 0) <= PER_VOTER_CAP);
});

test("a young citizen can't be a seed, so a pod of fresh accounts can't bootstrap itself", () => {
  // Kill: drop the SEED_MIN_AGE_DAYS condition.
  const born = new Map<number, number>();
  const edges: VoteEdge[] = [];
  // 12 accounts, 31 days old, each voting for every other: a big pod and nobody else.
  for (let i = 1; i <= 12; i++) born.set(i, NOW - 31 * DAY);
  for (let a = 1; a <= 12; a++) for (let b = 1; b <= 12; b++) if (a !== b) edges.push({ voter: a, author: b, n: 5, first: NOW - 1 * DAY });
  assert.equal(trustedKarma(edges, born, NOW).size, 0);
});

test("a citizen needs 10 different voters to be a seed", () => {
  // Kill: lower SEED_MIN_VOTERS in the seed filter, or count votes instead of voters.
  const born = new Map<number, number>();
  const edges: VoteEdge[] = [];
  // 9 old accounts each voting 50 times for each other: 8 distinct voters each, never 10.
  for (let i = 1; i <= 9; i++) born.set(i, NOW - 120 * DAY);
  for (let a = 1; a <= 9; a++) for (let b = 1; b <= 9; b++) if (a !== b) edges.push({ voter: a, author: b, n: 50, first: NOW - 60 * DAY });
  assert.equal(trustedKarma(edges, born, NOW).size, 0);
});

test("an aged pod (old accounts that start voting for each other after the snapshot) gets nothing", () => {
  // Kill: count votes cast after SEED_SNAPSHOT toward the seed rule (the hole the
  // pre-deploy audit found on 2026-11-09: 11+ old accounts made themselves seeds).
  const { born, edges } = society();
  const pod = Array.from({ length: 50 }, (_, i) => 500 + i);
  for (const p of pod) born.set(p, NOW - 100 * DAY); // old enough to be a seed by age alone
  for (const a of pod) for (const b of pod) if (a !== b) edges.push({ voter: a, author: b, n: 30, first: NOW - 12 * 3600_000 }); // after Nov 8
  const tk = trustedKarma(edges, born, NOW);
  for (const p of pod) assert.equal(tk.get(p) ?? 0, 0, `pod member ${p}`);
});

test("one old sleeper account plus young sybils voting for it after the snapshot can't seed anything", () => {
  // Kill: same as above; the sleeper's voters must have voted before the snapshot.
  const { born, edges } = society();
  born.set(600, NOW - 200 * DAY); // the sleeper
  const sybils = Array.from({ length: 100 }, (_, i) => 700 + i);
  for (const s of sybils) { born.set(s, NOW - 45 * DAY); edges.push({ voter: s, author: 600, n: 3, first: NOW - 6 * 3600_000 }); }
  for (const s of sybils) edges.push({ voter: 600, author: s, n: 3, first: NOW - 6 * 3600_000 });
  const tk = trustedKarma(edges, born, NOW);
  assert.equal(tk.get(600) ?? 0, 0);
  for (const s of sybils) assert.equal(tk.get(s) ?? 0, 0, `sybil ${s}`);
});

test("a seed's age is measured on the snapshot date, not today", () => {
  // Kill: compare born to now - SEED_MIN_AGE_DAYS instead of the snapshot - SEED_MIN_AGE_DAYS.
  const { born, edges } = society();
  const snapshot = Date.UTC(2026, 10, 8);
  // 12 accounts 59.5 days old on the snapshot (60.5 today) that voted for each other before it.
  const grp = Array.from({ length: 12 }, (_, i) => 800 + i);
  for (const g of grp) born.set(g, snapshot - 59.5 * DAY);
  for (const a of grp) for (const b of grp) if (a !== b) edges.push({ voter: a, author: b, n: 3, first: snapshot - 1 * DAY });
  const tk = trustedKarma(edges, born, snapshot + 1 * DAY);
  for (const g of grp) assert.equal(tk.get(g) ?? 0, 0, `member ${g}`);
});
