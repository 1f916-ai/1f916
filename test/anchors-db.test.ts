// Anchors against a real schema: the cron pass, its dedupe, the archive
// hour-gate, Base confirmation, the listing, the two file downloads. Every
// outbound call is a stub handed in through AnchorDeps, so this runs offline
// and still executes every SQL statement in src/anchors.ts for the scan guard.
//
// Killing mutations, each checked in a scratch copy:
//   - INSERT OR IGNORE -> INSERT: the second pass throws on UNIQUE, red.
//   - drop the 55-minute archive gate: the second pass attempts the archive
//     again, `attempted` is 1 not 0, red.
//   - skip the UPDATE in the confirmation loop: base rows stay pending, red.
//   - stop filtering archive attempts to identity_events: two archive rows, red.
//   - serve `proof` for a non-ots row: the base .ots download returns bytes
//     instead of null, red.
//   - LIMIT 2 -> LIMIT 200 on the confirmation query: three pending rows
//     confirm in one pass instead of two, red.
//   - skip the archive job UPDATE: the job row stays pending, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, anchorFile, listAnchors, OTS_CALENDARS, OTS_MAGIC, type AnchorDeps } from "../src/anchors.ts";
import { checkpointPayload } from "../src/checkpoint.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT_A = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const ROOT_B = "ce96f39e1f5a53795fb9b505c6c56c053438744fa7df5abd3026de0a7ea541d3";
const T0 = 1_790_000_000_000;

function fixture(): { env: Env; db: ReturnType<typeof sqliteTestEnv>["db"] } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES
    (10, 'identity_events', 5, '${ROOT_A}', 'sigA', ${T0 - 1000}),
    (11, 'ledger', 2, '${ROOT_B}', 'sigB', ${T0 - 900})`);
  return { env, db };
}

const CAL_BYTES = new Uint8Array([0xf0, 0x08, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x08, 0x00]);

function deps(opts: { calendarFails?: string; archive?: "anon-500" | "keys-ok" | "anon-ok"; confirm?: "pending" | "confirmed" | "failed" } = {}): AnchorDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/digest")) {
        if (opts.calendarFails && url.startsWith(opts.calendarFails)) return new Response("nope", { status: 502 });
        return new Response(CAL_BYTES, { status: 200 });
      }
      if (url === "https://web.archive.org/save") return new Response(JSON.stringify({ job_id: "job-1" }), { status: 200 });
      if (url.startsWith("https://web.archive.org/save/")) {
        if (opts.archive === "anon-ok") return new Response("", { status: 200, headers: { "content-location": "/web/20260925000000/https://1f916.ai/api/checkpoint" } });
        return new Response("", { status: 500 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch,
    submitBase: async (_env, payload) => {
      calls.push(`base ${payload}`);
      return "0x" + "ab".repeat(32);
    },
    confirmBase: async () => opts.confirm ?? "pending",
  };
}

test("one pass anchors both heads to every calendar, Base once each, and the archive once (identity log only)", async () => {
  const { env, db } = fixture();
  const d = deps({ archive: "anon-500" });
  const r = await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) }, T0, d);
  assert.equal(r.attempted, 2 * OTS_CALENDARS.length + 2 + 1);
  assert.equal(r.recorded, 2 * OTS_CALENDARS.length + 2, "ots and base rows recorded");
  assert.equal(r.failed, 1, "the anonymous archive refusal is one failed row, not an exception");
  assert.equal(r.base_enabled, true);
  const rows = db.prepare("SELECT checkpoint_id, kind, target, status, error FROM anchors ORDER BY id").all() as { checkpoint_id: number; kind: string; target: string; status: string; error: string | null }[];
  assert.equal(rows.length, r.attempted);
  assert.deepEqual(rows.filter((x) => x.kind === "archive").map((x) => [x.checkpoint_id, x.status, x.error]), [[10, "failed", "spn 500"]]);
  assert.deepEqual(rows.filter((x) => x.kind === "base").map((x) => [x.checkpoint_id, x.status]), [[10, "pending"], [11, "pending"]]);
  for (const cal of OTS_CALENDARS) assert.equal(rows.filter((x) => x.kind === "ots" && x.target === cal).length, 2, `${cal} asked once per checkpoint`);
  // The Base calldata is the payload text, so the wallet stub saw it verbatim.
  assert.ok(d.calls.includes(`base ${checkpointPayload("identity_events", 5, ROOT_A, T0 - 1000)}`));

  // Second pass at the same minute: nothing is due. No duplicate rows, no
  // second archive attempt inside the hour.
  const again = await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) }, T0 + 30_000, d);
  assert.equal(again.attempted, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors").get() as { n: number }).n, rows.length);
});

test("a new head inside the hour gets calendars and Base but not another archive attempt; after 55 minutes it does", async () => {
  const { env, db } = fixture();
  const withKey = { ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) };
  await anchorCheckpoints(withKey, T0, deps({ archive: "anon-500" }));
  // Ten minutes later the identity log has a new head.
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (12, 'identity_events', 6, '${ROOT_B}', 'sigC', ${T0 + 600_000 - 1})`);
  const soon = await anchorCheckpoints(withKey, T0 + 600_000, deps({ archive: "anon-ok" }));
  assert.equal(soon.attempted, OTS_CALENDARS.length + 1, "calendars and Base for the new head; the archive is inside its hour");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE kind = 'archive'").get() as { n: number }).n, 1);
  // Another new head, an hour after the first archive attempt.
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (13, 'identity_events', 7, '${ROOT_A}', 'sigD', ${T0 + 3_600_000 - 1})`);
  const later = await anchorCheckpoints(withKey, T0 + 3_600_000, deps({ archive: "anon-ok" }));
  assert.equal(later.attempted, OTS_CALENDARS.length + 1 + 1, "calendars, Base, and the archive again");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE kind = 'archive'").get() as { n: number }).n, 2);
});

test("Base rows confirm on a later pass, and a reverted receipt is recorded as failed", async () => {
  const { env, db } = fixture();
  const withKey = { ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) };
  await anchorCheckpoints(withKey, T0, deps({ archive: "anon-500" }));
  const still = await anchorCheckpoints(withKey, T0 + 30_000, deps({ confirm: "pending" }));
  assert.equal(still.confirmed, 0, "younger than a minute: not even asked");
  const done = await anchorCheckpoints(withKey, T0 + 120_000, deps({ confirm: "confirmed" }));
  assert.equal(done.confirmed, 2);
  const rows = (db.prepare("SELECT status, confirmed_at FROM anchors WHERE kind = 'base' ORDER BY id").all() as { status: string; confirmed_at: number | null }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows, [{ status: "confirmed", confirmed_at: T0 + 120_000 }, { status: "confirmed", confirmed_at: T0 + 120_000 }]);
  // A fresh fixture whose receipt reverts.
  const f2 = fixture();
  const k2 = { ...f2.env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) };
  await anchorCheckpoints(k2, T0, deps({ archive: "anon-500" }));
  const bad = await anchorCheckpoints(k2, T0 + 120_000, deps({ confirm: "failed" }));
  assert.equal(bad.failed, 2);
  assert.deepEqual((f2.db.prepare("SELECT DISTINCT status FROM anchors WHERE kind = 'base'").all() as { status: string }[]).map((x) => x.status), ["failed"]);
});

test("Base confirmations are capped at two per pass, so a backlog drains over passes", async () => {
  const { env, db } = fixture();
  const withKey = { ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) };
  await anchorCheckpoints(withKey, T0, deps({ archive: "anon-500" }));
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (12, 'identity_events', 6, '${ROOT_B}', 'sigC', ${T0 + 5_000})`);
  await anchorCheckpoints(withKey, T0 + 10_000, deps());
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE kind = 'base' AND status = 'pending'").get() as { n: number }).n, 3, "three pending Base rows");
  const first = await anchorCheckpoints(withKey, T0 + 120_000, deps({ confirm: "confirmed" }));
  assert.equal(first.confirmed, 2, "exactly two receipts asked for per pass");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE kind = 'base' AND status = 'pending'").get() as { n: number }).n, 1);
  const second = await anchorCheckpoints(withKey, T0 + 130_000, deps({ confirm: "confirmed" }));
  assert.equal(second.confirmed, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM anchors WHERE kind = 'base' AND status = 'pending'").get() as { n: number }).n, 0);
});

test("an authenticated archive job is polled on later passes: success rewrites the row to the capture URL, an archive error is recorded", async () => {
  const keys = { ARCHIVE_ORG_ACCESS: "ak", ARCHIVE_ORG_SECRET: "sk" };
  const { env, db } = fixture();
  const withKeys = { ...env, ...keys };
  await anchorCheckpoints(withKeys, T0, deps());
  const jobStatus = (body: object) => {
    const d = deps();
    const inner = d.fetch;
    d.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://web.archive.org/save/status/")) { d.calls.push(`GET ${url}`); return new Response(JSON.stringify(body), { status: 200 }); }
      return inner(input, init);
    }) as typeof fetch;
    return d;
  };
  const still = await anchorCheckpoints(withKeys, T0 + 300_000, jobStatus({ status: "pending" }));
  assert.equal(still.confirmed + still.failed, 0);
  assert.equal((db.prepare("SELECT status FROM anchors WHERE kind = 'archive'").get() as { status: string }).status, "pending");
  const done = await anchorCheckpoints(withKeys, T0 + 600_000, jobStatus({ status: "success", timestamp: "20260925010203", original_url: "https://1f916.ai/api/checkpoint" }));
  assert.equal(done.confirmed, 1);
  const row = db.prepare("SELECT status, target, confirmed_at FROM anchors WHERE kind = 'archive'").get() as { status: string; target: string; confirmed_at: number };
  assert.deepEqual({ ...row }, { status: "confirmed", target: "https://web.archive.org/web/20260925010203/https://1f916.ai/api/checkpoint", confirmed_at: T0 + 600_000 });
  // A second fixture whose job errors.
  const f2 = fixture();
  const k2 = { ...f2.env, ...keys };
  await anchorCheckpoints(k2, T0, deps());
  const bad = await anchorCheckpoints(k2, T0 + 300_000, jobStatus({ status: "error", message: "blocked by robots" }));
  assert.equal(bad.failed, 1);
  const r2 = f2.db.prepare("SELECT status, error FROM anchors WHERE kind = 'archive'").get() as { status: string; error: string };
  assert.deepEqual({ ...r2 }, { status: "failed", error: "blocked by robots" });
});

test("a calendar outage is one failed row with the error text; the other calendars still record", async () => {
  const { env, db } = fixture();
  const r = await anchorCheckpoints(env, T0, deps({ calendarFails: OTS_CALENDARS[0], archive: "anon-ok" }));
  assert.equal(r.base_enabled, false, "no key, no Base attempt");
  assert.equal(r.failed, 2, "one calendar down, two checkpoints");
  const failed = db.prepare("SELECT target, error FROM anchors WHERE status = 'failed'").all() as { target: string; error: string }[];
  assert.deepEqual(failed.map((x) => x.target), [OTS_CALENDARS[0], OTS_CALENDARS[0]]);
  assert.match(failed[0].error, /calendar 502/);
  const archive = (db.prepare("SELECT target, status FROM anchors WHERE kind = 'archive'").all() as { target: string; status: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(archive, [{ target: "https://web.archive.org/web/20260925000000/https://1f916.ai/api/checkpoint", status: "confirmed" }]);
});

test("with archive keys the authenticated API is used and the job status URL is the pending target", async () => {
  const { env, db } = fixture();
  const d = deps();
  const r = await anchorCheckpoints({ ...env, ARCHIVE_ORG_ACCESS: "ak", ARCHIVE_ORG_SECRET: "sk" }, T0, d);
  assert.equal(r.archive_keys, true);
  assert.ok(d.calls.includes("POST https://web.archive.org/save"));
  const archive = (db.prepare("SELECT target, status FROM anchors WHERE kind = 'archive'").all() as { target: string; status: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(archive, [{ target: "https://web.archive.org/save/status/job-1", status: "pending" }]);
});

test("GET /api/anchors lists rows oldest-first with the covered text, links the files, pages by since_id, and shows the current heads", async () => {
  const { env } = fixture();
  await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) }, T0, deps({ archive: "anon-500" }));
  const all = await listAnchors(env, undefined);
  assert.equal(all.anchors.length, 2 * OTS_CALENDARS.length + 3);
  assert.equal(all.has_more, false);
  assert.equal(all.next_since_id, all.anchors[all.anchors.length - 1].id);
  const ots = all.anchors.find((a) => a.kind === "ots")!;
  assert.equal(ots.payload, checkpointPayload("identity_events", 5, ROOT_A, T0 - 1000));
  assert.equal(ots.ots_file, `/api/anchors/${ots.id}.ots`);
  assert.equal(ots.payload_file, `/api/anchors/${ots.id}.txt`);
  const base = all.anchors.find((a) => a.kind === "base")!;
  assert.equal("ots_file" in base, false, "no proof file link on a Base row");
  assert.equal(all.latest_checkpoints.length, 2);
  assert.equal(all.latest_checkpoints[0].anchors.length, OTS_CALENDARS.length + 2, "identity head: calendars, base, archive");
  assert.equal(all.latest_checkpoints[1].anchors.length, OTS_CALENDARS.length + 1, "ledger head: calendars, base");
  const page = await listAnchors(env, all.anchors[all.anchors.length - 2].id);
  assert.equal(page.anchors.length, 1);
  assert.equal(page.anchors[0].id, all.next_since_id);
});

test("the .txt download is the exact covered text and the .ots download is the proof file; no proof for a Base row", async () => {
  const { env, db } = fixture();
  await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: "0x" + "11".repeat(32) }, T0, deps({ archive: "anon-500" }));
  const ots = db.prepare("SELECT id FROM anchors WHERE kind = 'ots' ORDER BY id LIMIT 1").get() as { id: number };
  const base = db.prepare("SELECT id FROM anchors WHERE kind = 'base' ORDER BY id LIMIT 1").get() as { id: number };
  const txt = await anchorFile(env, ots.id, "txt");
  assert.equal(txt?.body, checkpointPayload("identity_events", 5, ROOT_A, T0 - 1000));
  assert.equal(txt?.type, "text/plain; charset=utf-8");
  const proof = await anchorFile(env, ots.id, "ots");
  assert.ok(proof && proof.body instanceof Uint8Array);
  const bytes = proof!.body as Uint8Array;
  assert.deepEqual(Array.from(bytes.slice(0, OTS_MAGIC.length)), Array.from(OTS_MAGIC));
  assert.deepEqual(Array.from(bytes.slice(-CAL_BYTES.length)), Array.from(CAL_BYTES), "ends with the calendar's bytes untouched");
  assert.equal(await anchorFile(env, base.id, "ots"), null);
  assert.equal(await anchorFile(env, 9_999, "txt"), null);
});
