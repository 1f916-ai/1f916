// The registry no longer starts the GitHub witness (src/witness-cadence.ts).
//
// From 2026-08-12 the Worker's cron fired a workflow_dispatch at GitHub on
// every tick. This file used to guard the record of those attempts: the
// dispatch once failed for 53 hours with a console line as its only trace
// (xinren, post 1264), so each attempt was written to one row and served with
// its age. On 2026-09-29 the trigger was removed, because a job started on a
// timer by a running service is not what GitHub's terms for Actions allow.
//
// What is guarded now is the removal. The Worker must not speak to GitHub on
// its clock, with a token or without one, and the surfaces must say the
// trigger is gone rather than that it failed: a reader who watches the age of
// the last attempt would otherwise read the end of the trigger as an outage.
// The row stays and is served as history.
//
// Eight tests stood here. Four exercised recordWitnessDispatch, which no
// longer exists. The other four are kept in the shape the change gives them.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-29):
//   W1  put the dispatch back in the scheduled handler          -> "a tick of the clock makes no request to GitHub, with a token or without"
//   W2  name GitHub's workflow API anywhere under src/          -> "nothing under src/ can start a GitHub workflow"
//   W3  serve the last attempt as a failure of a live trigger   -> "the last attempt is served as history, and says the trigger is retired"
//   W4  say "no attempt recorded yet" of a trigger that is gone -> "with no row, the view says the registry does not trigger the witness"
//   W5  let a missing table throw                               -> "a missing table reads as nothing recorded, never a throw"
//   W6  write a cadence sentence by hand on one surface         -> "every surface says the same thing about the witness, from the one module"
//   W7  date the standing sentence without its date             -> "the dated sentence carries its own date, and the dates are in order"
//   W8  read the retired field as proof the handler ran         -> "a frozen sequence is not sorted by a field that no longer moves"
//   W9  say the job is "started by nothing else"                -> "the dated sentence carries its own date, and the dates are in order"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import worker from "../src/index.ts";
import { makeCheckpoints, readWitnessDispatch, witnessDispatchView, type WitnessDispatchRow } from "../src/checkpoint.ts";
import {
  WITNESS_CADENCE,
  WITNESS_LAST_LINE,
  WITNESS_RESUMED,
  WITNESS_RESUMED_WRITTEN,
  WITNESS_SCHEDULE,
  WITNESS_STANDING,
  WITNESS_STANDING_WRITTEN,
  WITNESS_TRIGGER_FROM,
  WITNESS_TRIGGER_LAST,
  WITNESS_TRIGGER_NEVER_NOTE,
  WITNESS_TRIGGER_RETIRED_NOTE,
} from "../src/witness-cadence.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const SCHEMA = readFileSync(join(root, "schema.sql"), "utf8");
const MIGRATION = readFileSync(join(root, "migrations", "0034_witness_dispatch.sql"), "utf8");

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
function registrySeed(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return `${b64u(seed)}.${b64u(pub)}`;
}

// One tick of the Worker's clock with every outbound request caught. Nothing
// leaves the process: each request is answered 503 here, which is what an
// anchor or a provider being down looks like, and the handler logs and goes on.
async function tick(extra: Record<string, unknown>): Promise<string[]> {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  const asked: string[] = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  const waiting: Promise<unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    asked.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
  try {
    await worker.scheduled!({ cron: "*/5 * * * *", scheduledTime: 0 } as never, { ...env, ...extra } as unknown as Env, {
      waitUntil: (p: Promise<unknown>) => void waiting.push(p),
      passThroughOnException: () => {},
    } as never);
    await Promise.allSettled(waiting);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  }
  return asked;
}

const toGitHub = (urls: string[]) => urls.filter((u) => /(^|[/.@])github(usercontent)?\.com/i.test(u));

test("a tick of the clock makes no request to GitHub, with a token or without", async () => {
  // The secret is deleted in production. A deployment that still held one must
  // behave the same: the promise is that the code cannot, not that the token is missing.
  const withToken = await tick({ GH_WITNESS_TOKEN: "a-token-that-must-never-be-sent", REGISTRY_SEED: registrySeed() });
  assert.deepEqual(toGitHub(withToken), []);
  assert.ok(!withToken.some((u) => u.includes("a-token-that-must-never-be-sent")));
  assert.deepEqual(toGitHub(await tick({ GH_WITNESS_TOKEN: "a-token-that-must-never-be-sent" })), []);
  assert.deepEqual(toGitHub(await tick({ REGISTRY_SEED: registrySeed() })), []);
  assert.deepEqual(toGitHub(await tick({})), []);
});

test("nothing under src/ can start a GitHub workflow", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(join(root, "src")).filter((n) => n.endsWith(".ts"))) {
    readFileSync(join(root, "src", f), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/actions\/workflows|\/dispatches\b|GH_WITNESS_TOKEN|workflow_dispatch/.test(line) && !/^\s*\/\//.test(line)) offenders.push(`src/${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
  }
  assert.deepEqual(offenders, []);
  // And the Worker is configured with no such secret by name.
  assert.ok(!/GH_WITNESS_TOKEN/.test(readFileSync(join(root, "wrangler.jsonc"), "utf8")));
});

test("the last attempt is served as history, and says the trigger is retired", () => {
  const row: WitnessDispatchRow = { last_attempt_at: 61_000, last_status: 422, last_error: null, last_ok_at: 1000 };
  const v = witnessDispatchView(row, 121_000);
  assert.deepEqual(v, {
    recorded: true,
    retired: true,
    last_attempt_at: 61_000,
    last_attempt_age_seconds: 60,
    last_status: 422,
    last_error: null,
    last_ok_at: 1000,
    last_ok_age_seconds: 120,
    note: WITNESS_TRIGGER_RETIRED_NOTE,
  });
  // The age moves with the clock and the note does not change with the status:
  // an accepted last attempt is history too.
  assert.equal(witnessDispatchView(row, 181_000).last_attempt_age_seconds, 120);
  assert.equal(witnessDispatchView({ ...row, last_status: 204 }, 121_000).note, WITNESS_TRIGGER_RETIRED_NOTE);
  assert.equal(witnessDispatchView({ ...row, last_ok_at: null }, 121_000).last_ok_age_seconds, null);
  assert.doesNotMatch(v.note, /FAILED|degrades|backstop/);
  assert.match(v.note, /the registry no longer triggers the witness/);
  assert.match(v.note, /they will not move again/);
});

test("with no row, the view says the registry does not trigger the witness", () => {
  const v = witnessDispatchView(null, 1000);
  assert.deepEqual(v, { recorded: false, retired: true, note: WITNESS_TRIGGER_NEVER_NOTE });
  assert.doesNotMatch(v.note, /yet|token is unset|backstop/);
});

test("a missing table reads as nothing recorded, never a throw", async () => {
  const { env } = sqliteTestEnv("-- no witness_dispatch table");
  assert.equal(await readWitnessDispatch(env), null);
  const { env: held, db } = sqliteTestEnv(MIGRATION);
  assert.equal(await readWitnessDispatch(held), null);
  db.exec("INSERT INTO witness_dispatch (id, last_attempt_at, last_status, last_error, last_ok_at) VALUES (1, 61000, 422, NULL, 1000)");
  assert.deepEqual({ ...(await readWitnessDispatch(held)) }, { last_attempt_at: 61_000, last_status: 422, last_error: null, last_ok_at: 1000 });
});

test("every surface says the same thing about the witness, from the one module", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  const e = { ...env, REGISTRY_SEED: registrySeed() } as unknown as Env;
  const get = async (path: string) => (await worker.fetch(new Request(`https://1f916.ai${path}`, { headers: { Accept: "application/json" } }), e)).text();
  const official = JSON.parse(await get("/api/official")) as { public_witness: { cadence: string } };
  const attest = JSON.parse(await get("/api/attest")) as { public_witness: string };
  const checkpoint = JSON.parse(await get("/api/checkpoint")) as { how_to_verify: string; witness_dispatch: { retired: boolean; note: string } };
  const surfaceRow = SURFACE.find((r) => r.path === "/api/checkpoint" && r.method === "GET")!.summary;
  const said: Record<string, string> = {
    "official.public_witness.cadence": official.public_witness.cadence,
    "attest.public_witness": attest.public_witness,
    "checkpoint.how_to_verify": checkpoint.how_to_verify,
  };
  for (const [where, text] of Object.entries(said)) {
    assert.ok(text.includes(WITNESS_CADENCE), `${where} states the schedule and the end of the trigger`);
    assert.ok(text.includes(WITNESS_STANDING), `${where} carries the dated observation`);
    assert.doesNotMatch(text, /fires a dispatch|fires the dispatch|is the backstop|as the backstop|dispatch is attempted/, where);
    assert.doesNotMatch(text, /ATTEMPTED every five minutes/, where);
  }
  assert.ok(surfaceRow.includes(WITNESS_SCHEDULE));
  assert.doesNotMatch(surfaceRow, /five-minute attempted cadence|backstop/);
  assert.equal(checkpoint.witness_dispatch.retired, true);
  assert.equal(checkpoint.witness_dispatch.note, WITNESS_TRIGGER_NEVER_NOTE);
});

test("the dated sentence carries its own date, and the dates are in order", () => {
  assert.equal(WITNESS_SCHEDULE, "scheduled hourly by GitHub's own scheduler; the registry does not start it, and a run can still be started by hand by whoever holds write access to the repository");
  assert.equal(
    WITNESS_CADENCE,
    "It is scheduled hourly by GitHub's own scheduler; the registry does not start it, and a run can still be started by hand by whoever holds write access to the repository. From 2026-08-12T03:41Z until 2026-09-29T01:46:21Z the registry's cron also attempted a dispatch every five minutes; it no longer does",
  );
  // The sentence may not claim more than the workflow file allows: while the
  // file declares a manual trigger, nothing here says the job has no other start.
  const workflow = readFileSync(join(root, ".github", "workflows", "witness.yml"), "utf8");
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m, "the manual trigger is still declared");
  assert.match(workflow, /cron: "7 \* \* \* \*"/, "and the schedule is hourly");
  for (const s of [WITNESS_SCHEDULE, WITNESS_CADENCE, WITNESS_TRIGGER_RETIRED_NOTE, WITNESS_TRIGGER_NEVER_NOTE, readFileSync(join(root, "witness", "README.md"), "utf8")]) {
    assert.doesNotMatch(s, /started by nothing else|nothing else starts/);
  }
  assert.equal(
    WITNESS_STANDING,
    "Written 2026-09-29: the witness log went quiet after 2026-09-28T16:26:28Z, and from that run until this was written the job did not run and the repository was not publicly readable. Updated 2026-10-08: the witness has resumed, its first head line after the gap at 2026-10-08T19:52:35Z. Each clause is dated; the day files' own timestamps are the record",
  );
  assert.ok(WITNESS_STANDING.startsWith(`Written ${WITNESS_STANDING_WRITTEN}: `));
  const t = (s: string) => Date.parse(s.length === 17 ? s.replace("Z", ":00Z") : s);
  assert.ok(t(WITNESS_TRIGGER_FROM) < t(WITNESS_LAST_LINE), "the trigger began before the last head line");
  assert.ok(t(WITNESS_LAST_LINE) < t(WITNESS_TRIGGER_LAST), "the registry went on attempting after the last line landed");
  assert.ok(t(WITNESS_TRIGGER_LAST) < Date.parse(`${WITNESS_STANDING_WRITTEN}T23:59:59Z`), "and stopped on the day the sentence was written");
  // The gap runs forward: the last line before it, then the resume after it.
  assert.ok(t(WITNESS_LAST_LINE) < Date.parse(WITNESS_RESUMED), "the witness resumed after it went quiet");
  assert.ok(Date.parse(`${WITNESS_STANDING_WRITTEN}T23:59:59Z`) < Date.parse(WITNESS_RESUMED), "and the resume is a later day than the standing sentence");
  // The two lines the sentence names are real lines in their own day files,
  // not a claim about which file is newest: the witness runs on and writes
  // newer files, but these two bracket a closed gap and do not move. The day
  // before the gap ends on WITNESS_LAST_LINE; the day it resumed opens on
  // WITNESS_RESUMED (the first head of that file, since nothing ran earlier
  // that day). Each head's countersignatures follow it within the minute.
  const dayFile = (at: string) =>
    readFileSync(join(root, "witness", `${at.slice(0, 10)}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { at: string; type?: string });
  const before = dayFile(WITNESS_LAST_LINE);
  const beforeHeads = before.filter((l) => l.type === undefined);
  assert.equal(beforeHeads[beforeHeads.length - 1].at, WITNESS_LAST_LINE, "the pre-gap file ends on the last line named");
  const resumed = dayFile(WITNESS_RESUMED);
  const resumedHeads = resumed.filter((l) => l.type === undefined);
  assert.equal(resumedHeads[0].at, WITNESS_RESUMED, "the resume file opens on the first line after the gap");
  // The lines between a named head and the next head (or end of file) are that
  // run's countersignatures, seconds later.
  for (const [parsed, head] of [[before, WITNESS_LAST_LINE], [resumed, WITNESS_RESUMED]] as const) {
    const start = parsed.findIndex((l) => l.type === undefined && l.at === head);
    const nextHead = parsed.findIndex((l, i) => i > start && l.type === undefined);
    const after = parsed.slice(start + 1, nextHead === -1 ? undefined : nextHead);
    assert.ok(after.length > 0 && after.every((l) => l.type === "witness-countersignature" && Date.parse(l.at) - Date.parse(head) < 60_000), `countersignatures follow ${head} within the minute`);
  }
});

test("a frozen sequence is not sorted by a field that no longer moves", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'keeper', 'test-model', 'h1', 0, 0)`);
  db.exec("INSERT INTO witness_dispatch (id, last_attempt_at, last_status, last_error, last_ok_at) VALUES (1, 61000, 422, NULL, 1000)");
  const e = { ...env, REGISTRY_SEED: registrySeed() } as unknown as Env;
  await makeCheckpoints(e);
  const body = (await (await worker.fetch(new Request("https://1f916.ai/api/checkpoint"), e)).json()) as {
    checkpoint_sequence: { recorded: boolean; note: string };
    witness_dispatch: { retired: boolean; last_attempt_at: number };
  };
  assert.equal(body.checkpoint_sequence.recorded, true, "the note under test is the one served beside a readable sequence");
  const note = body.checkpoint_sequence.note;
  // The recipe this note used to give would now read every pass as "the handler did not run".
  assert.doesNotMatch(note, /Dispatch not advancing: the handler did not run/);
  assert.doesNotMatch(note, /so it proves the handler ran/);
  assert.doesNotMatch(note, /Dispatch advancing/);
  assert.match(note, /Nothing served here proves the handler ran when this step did not\./);
  assert.match(note, /that leg was removed \(witness_dispatch\.retired\) and the field will not move again/);
  assert.match(note, /these cannot be told apart from here/);
  // And the field it points at is there, saying so.
  assert.equal(body.witness_dispatch.retired, true);
  assert.equal(body.witness_dispatch.last_attempt_at, 61_000);
});
