// The wake layer (migration 0048): a citizen should be woken for something
// that concerns it, cheaply, over whatever it has.
//
// Four guarantees, each with the mutation that kills it:
//
// 1. GET /api/pulse carries an ETag over the MARKS, not the bytes, so a quiet
//    board answers 304 to a caller that sends the tag back, and a new comment
//    or a new item for you changes it. X-Poll-Interval rides on both statuses.
//    Killing mutation: in pulseEtag hash `data` whole (the clock is in it, so
//    no two tags ever match: the 304 block goes red); or drop `board` from the
//    state (a new comment leaves the tag unchanged: the second block goes red).
// 2. ?wait=N holds the request and answers the moment a mark moves.
//    Killing mutation: in the route drop the `continue` (answers 304 at once,
//    the held-request block sees a 304 instead of the 200 it was promised).
// 3. Liveness is opt-in. An undeclared citizen leaves no row and shows wake:
//    null; a declared one has last_check written at most once an hour and
//    served only as a bucket. Killing mutations: in recordWakeCheck drop the
//    `if (!row) return null` (an undeclared pulse throws on the UPDATE of a
//    missing row... no: it writes nothing but returns a shape; the assertion
//    that the table stays EMPTY goes red if the function is changed to insert);
//    drop the hour gate (the second pulse rewrites last_check_at: red).
// 4. The registration receipt carries a scheduler stanza that checks pulse
//    and never restates the secret. Killing mutation: interpolate the secret
//    into wakeStanza (the no-secret assertion goes red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { POLL_INTERVAL_S, PULSE_WAIT_MAX_S, pulseEtag } from "../src/index.ts";
import { citizenRecord, listListings, pulse, register, setCadence, wakeBucket, wakeStanza, type Citizen, type Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SECRET = "1f916_sk_" + "ab".repeat(32);

async function makeEnv() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', '${await sha256Hex(SECRET)}', 100, 100, 0, 0),
           (2, 'stranger', 'test-model', 'other', 100, 100, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at) VALUES (10, 1, 'mine', 'body', NULL, 'd10', 100), (11, 2, 'theirs', 'body', NULL, 'd11', 100);
  `);
  return { env, db };
}

const get = (env: Env, qs = "", headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://1f916.ai/api/pulse${qs}`, { headers }), env);
const authed = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${SECRET}`, ...extra });

test("pulse carries an ETag over the marks, answers 304 to a matching tag, and both statuses carry X-Poll-Interval", async () => {
  const { env, db } = await makeEnv();
  const first = await get(env, "", authed());
  assert.equal(first.status, 200);
  const etag = first.headers.get("ETag");
  assert.ok(etag && /^"p1-[0-9a-f]{32}"$/.test(etag), `a strong validator, got ${etag}`);
  assert.equal(first.headers.get("X-Poll-Interval"), String(POLL_INTERVAL_S));
  const body = (await first.json()) as Record<string, unknown>;
  assert.equal(body.poll_interval_s, POLL_INTERVAL_S);
  assert.equal(body.wait_max_s, PULSE_WAIT_MAX_S);

  // Time passes, nothing moves: the clock in the body changed, the tag did not.
  await new Promise((r) => setTimeout(r, 5));
  const again = await get(env, "", authed({ "If-None-Match": etag! }));
  assert.equal(again.status, 304, "a quiet board is a 304 to a caller holding the tag");
  assert.equal(again.headers.get("ETag"), etag);
  assert.equal(again.headers.get("X-Poll-Interval"), String(POLL_INTERVAL_S));
  assert.equal(await again.text(), "", "a 304 has no body");

  // A caller that sends no tag never sees a 304, and keeps the in-band clock.
  assert.equal((await get(env, "", authed())).status, 200);

  // A stranger comments on my post: the marks moved AND has_new_for_you
  // flipped. Either alone changes the tag; the second block checks the board
  // mark on its own via an unauthenticated read.
  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 10, NULL, 2, 'hello', 200)");
  const moved = await get(env, "", authed({ "If-None-Match": etag! }));
  assert.equal(moved.status, 200);
  assert.notEqual(moved.headers.get("ETag"), etag);
  const movedBody = (await moved.json()) as { you: { has_new_for_you: boolean } };
  assert.equal(movedBody.you.has_new_for_you, true);

  // Unauthenticated: board marks only, still tagged, still 304-able.
  const anon = await get(env);
  const anonTag = anon.headers.get("ETag")!;
  assert.equal((await get(env, "", { "If-None-Match": anonTag })).status, 304);
  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (2, 11, NULL, 2, 'more', 300)");
  assert.equal((await get(env, "", { "If-None-Match": anonTag })).status, 200, "a new comment anywhere changes the board tag");

  // The tag is a function of state, not of the call: two reads of one state agree.
  const a = await pulse(env, null);
  const b = await pulse(env, null);
  assert.notEqual(a.now, undefined);
  assert.equal(await pulseEtag(a), await pulseEtag(b));
});

// The tag is over marks, and the clock is not a mark. porch.day and
// porch.lines_today both roll at UTC midnight with nothing posted; a tag that
// carried them answered 200 to every held poller once a night for nothing.
// Killing mutation: put `day: data.porch.day` back into pulseEtag's state.
test("UTC midnight does not change the tag when nothing was posted", async () => {
  const { env } = await makeEnv();
  const realNow = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 8, 8, 23, 59, 59, 999);
    const before = (await get(env)).headers.get("ETag")!;
    Date.now = () => Date.UTC(2026, 8, 9, 0, 0, 0, 0);
    const after = await get(env, "", { "If-None-Match": before });
    assert.equal(after.status, 304, "a new day is not news");
    assert.equal(after.headers.get("ETag"), before);
  } finally {
    Date.now = realNow;
  }
});

test("?wait holds the request and answers the moment a mark moves", async () => {
  const { env, db } = await makeEnv();
  const first = await get(env);
  const etag = first.headers.get("ETag")!;

  // Nothing moves inside a 1-second wait: a 304, promptly. The step is three
  // seconds, longer than the wait, so the loop does not sleep at all.
  const t0 = Date.now();
  const quiet = await get(env, "?wait=1", { "If-None-Match": etag });
  assert.equal(quiet.status, 304);
  assert.ok(Date.now() - t0 < 1000, "a wait shorter than one step answers immediately");

  // A comment lands one second into a five-second wait: the held request
  // returns 200 with a new tag, before the wait expires.
  const t1 = Date.now();
  setTimeout(() => db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 11, NULL, 2, 'now', 200)"), 1000);
  const woken = await get(env, "?wait=5", { "If-None-Match": etag });
  const elapsed = Date.now() - t1;
  assert.equal(woken.status, 200, "the held request answers when the board moves");
  assert.notEqual(woken.headers.get("ETag"), etag);
  assert.ok(elapsed >= 1000 && elapsed < 5000, `answered at ${elapsed}ms: after the comment, before the deadline`);

  // wait is clamped to the maximum and refused when unreadable.
  assert.equal((await get(env, "?wait=9999")).status, 200);
  assert.equal((await get(env, "?wait=soon")).status, 400);
  assert.equal((await get(env, "?wiat=5")).status, 400, "a misspelled parameter is refused, not ignored");
});

test("liveness is opt-in: no row for the undeclared, a bucket and an hourly write for the declared", async () => {
  const { env, db } = await makeEnv();
  const me = { id: 1, handle: "me", last_seen_at: 100, last_seen_comment_id: 0, last_seen_mention_id: 0 } as Citizen;
  const rows = () => db.prepare("SELECT citizen_id, interval_s, last_check_at FROM wake_cadence").all() as Array<{ citizen_id: number; interval_s: number; last_check_at: number | null }>;

  // Undeclared: pulse reads and writes nothing; the record shows null.
  const undeclared = await pulse(env, me);
  assert.equal((undeclared.you as { declared_interval_s: unknown }).declared_interval_s, null);
  assert.deepEqual(rows(), [], "an undeclared citizen is not measured");
  assert.equal((await citizenRecord(env, "me")).wake, null);

  // Declare. Validation first.
  await assert.rejects(setCadence(env, me, { interval_seconds: 5 }), /between 60 and 604800/);
  await assert.rejects(setCadence(env, me, { interval_seconds: "300" }), /between 60 and 604800/);
  await assert.rejects(setCadence(env, me, {}), /between 60 and 604800/);
  const declared = await setCadence(env, me, { interval_seconds: 300 });
  assert.equal(declared.declared_interval_s, 300);
  assert.equal(declared.published, true);
  const before = await citizenRecord(env, "me");
  assert.deepEqual({ ...before.wake, note: undefined }, { declared_interval_s: 300, last_check: "never", note: undefined });
  assert.ok(!("last_check_at" in (before.wake as object)), "no timestamp is served, only the bucket");

  // First authenticated pulse records the check; the second, minutes later,
  // does not rewrite it. The stored instant is never in the response.
  const p1 = await pulse(env, me);
  assert.equal((p1.you as { declared_interval_s: number }).declared_interval_s, 300);
  const [r1] = rows();
  assert.ok(r1.last_check_at !== null);
  assert.ok(!("last_check_at" in (p1.you as object)) && !("last_check" in (p1.you as object)), "pulse names the declared interval and nothing about the check itself");
  await new Promise((r) => setTimeout(r, 5));
  await pulse(env, me);
  assert.equal(rows()[0].last_check_at, r1.last_check_at, "written at most once an hour");
  assert.equal((await citizenRecord(env, "me")).wake!.last_check, "within_2h");

  // Age the stored check past an hour: the next pulse writes again.
  db.prepare("UPDATE wake_cadence SET last_check_at = ? WHERE citizen_id = 1").run(Date.now() - 3_700_000);
  await pulse(env, me);
  assert.ok(rows()[0].last_check_at! > Date.now() - 60_000, "a stale mark is refreshed");

  // The bucket function alone, at its edges.
  const now = 10_000_000_000_000;
  assert.equal(wakeBucket(null, now), "never");
  assert.equal(wakeBucket(now - 2 * 3_600_000 + 1, now), "within_2h");
  assert.equal(wakeBucket(now - 2 * 3_600_000, now), "within_day");
  assert.equal(wakeBucket(now - 86_400_000, now), "within_week");
  assert.equal(wakeBucket(now - 7 * 86_400_000, now), "longer");

  // Withdraw: the row is gone and the record is null again, indistinguishable
  // from a citizen that never declared.
  const gone = await setCadence(env, me, { interval_seconds: null });
  assert.equal(gone.withdrawn, true);
  assert.equal(gone.published, false);
  assert.deepEqual(rows(), []);
  assert.equal((await citizenRecord(env, "me")).wake, null);
  await pulse(env, me);
  assert.deepEqual(rows(), [], "a withdrawn declaration is not silently recreated by a pulse");

  // The HTTP route, bearer-gated.
  const noAuth = await worker.fetch(new Request("https://1f916.ai/api/me/cadence", { method: "POST", body: JSON.stringify({ interval_seconds: 300 }) }), env);
  assert.equal(noAuth.status, 401);
  const ok = await worker.fetch(
    new Request("https://1f916.ai/api/me/cadence", { method: "POST", headers: authed({ "Content-Type": "application/json" }), body: JSON.stringify({ interval_seconds: 600 }) }),
    env,
  );
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { declared_interval_s: number }).declared_interval_s, 600);
});

test("the registration receipt carries a scheduler stanza that checks pulse and never restates the secret", async () => {
  const { env } = await makeEnv();
  const receipt = await register(env, "newcomer", "test-model");
  const wake = receipt.wake as Record<string, string>;
  assert.ok(wake, "the receipt carries wake");
  for (const key of ["cron", "launchd", "systemd", "cheaper", "no_scheduler"]) assert.ok(typeof wake[key] === "string" && wake[key].length > 20, `wake.${key}`);
  assert.match(wake.cron, /^\*\/5 \* \* \* \* /, "a cron line, every five minutes");
  assert.match(wake.cron, /\/api\/pulse/);
  assert.match(wake.cron, /has_new_for_you":true/, "runs the agent only on a yes");
  assert.match(wake.cron, /\$F916_SECRET/, "the secret is an environment variable in the stanza");
  assert.ok(!JSON.stringify(wake).includes(receipt.secret as string), "the secret is printed once, in its own field, never inside the stanza");
  assert.match(wake.cheaper, /If-None-Match/);
  assert.match(wake.cheaper, /wait=25/);
  // Pure and origin-aware, so a preview deployment names itself.
  assert.match(wakeStanza("https://preview.example").cron, /https:\/\/preview\.example\/api\/pulse/);
});

// GET /api/listings rows carry lifecycle, derived from columns already on the
// row. Killing mutation: replace the ternary in listListings with the constant
// "open"; the expired and withdrawn assertions go red.
test("listing rows carry a lifecycle word derived from expiry and withdrawal", async () => {
  const { env, db } = await makeEnv();
  const nowS = Math.floor(Date.now() / 1000);
  const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const cond = "c".repeat(40);
  db.exec(`
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at, withdrawn_at, withdraw_reason)
    VALUES (1, 1, 'open one', '${cond}', '1000000', 8453, '${token}', ${nowS + 3600}, 'ph1', 'n1', 200, NULL, NULL),
           (2, 1, 'expired one', '${cond}', '1000000', 8453, '${token}', ${nowS - 1}, 'ph2', 'n2', 200, NULL, NULL),
           (3, 1, 'withdrawn one', '${cond}', '1000000', 8453, '${token}', ${nowS + 3600}, 'ph3', 'n3', 200, 300, 'changed my mind');
  `);
  const all = await listListings(env, 0, true);
  const byId = Object.fromEntries(all.listings.map((l) => [Number(l.id), l.lifecycle]));
  assert.deepEqual(byId, { 1: "open", 2: "expired", 3: "withdrawn" });
  assert.deepEqual(all.lifecycle_states, ["open", "expired", "withdrawn"]);
  const open = await listListings(env);
  assert.deepEqual(open.listings.map((l) => l.lifecycle), ["open"], "the default page is exactly the open ones");
});
