// GET /records/:handle: the page a person opens to see what an agent has
// written down (recordsPage, src/mandates.ts).
//
// It is a list of somebody's records shown to anybody, so the two things it
// must never do are show another agent's records as this one's, and say
// "all" when there are more.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   R1  order the list oldest first                                 -> "the newest record comes first"
//   R2  drop the citizen from the WHERE                             -> "the list is one agent's records and nobody else's"
//   R3  drop `AND m.subject = ?`                                    -> "subject= narrows the list to one subject"
//   R4  never report that there are older records                   -> "a long list is cut at the cap and says so"
//   R5  say "All" on a list that was cut                            -> "one whole sentence for each case"
//   R6  count a result only when it was given at creation           -> "a result added afterwards counts as recorded"
//   R7  call a locked record public                                 -> "the list says how each record's text is kept"
//   R8  delete the route                                            -> "the page is served, and refuses what it does not understand"
//   R9  write the cap into the surface by hand, as a promise        -> "exactly the cap is the whole list, and says so"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { addOutcome, createMandate, recentMandates, recordsCountSentence, recordsPage, RECORDS_PAGE } from "../src/mandates.ts";
import { SocietyError, type Env, type Citizen } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T0 = 1_790_000_000_000;
const h = (n: number) => n.toString(16).padStart(64, "0");

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'bank', 'test-model', 'h1', 0, 0), (2, 'other', 'test-model', 'h2', 0, 0), (3, 'quiet', 'test-model', 'h3', 0, 0)`);
  const kv = new Map<string, unknown>();
  const e = { ...env, RECORDS: { put: async (k: string, v: unknown) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null } as unknown as KVNamespace } as Env;
  return { env: e, db, bank: { id: 1, handle: "bank" } as Citizen, other: { id: 2, handle: "other" } as Citizen };
}

// The ids of the records a page lists, in the order it lists them.
const listed = (page: string) => [...page.matchAll(/<td class="n"><a href="\/mandates\/(\d+)">\1<\/a><\/td>/g)].map((m) => Number(m[1]));
const rowOf = (page: string, id: number) => page.match(new RegExp(`<tr><td class="n"><a href="/mandates/${id}">.*?</tr>`))![0];

test("the newest record comes first", async () => {
  const { env, bank } = fixture();
  const ids: number[] = [];
  for (let i = 0; i < 3; i++) ids.push((await createMandate(env, bank, { instruction_hash: h(i + 1), action_hash: h(100 + i), label: `job-${i}` }, T0 + i * 1000)).id);
  const page = await recordsPage(env, "bank");
  assert.deepEqual(listed(page), [...ids].reverse());
  assert.match(page, /<h1>Records kept by bank<\/h1>/);
  assert.match(rowOf(page, ids[2]), /job-2/);
});

test("the list is one agent's records and nobody else's", async () => {
  const { env, bank, other } = fixture();
  const mine = await createMandate(env, bank, { instruction_hash: h(1), action_hash: h(2) }, T0);
  const theirs = await createMandate(env, other, { instruction_hash: h(3), action_hash: h(4) }, T0 + 1);
  assert.deepEqual(listed(await recordsPage(env, "bank")), [mine.id]);
  assert.deepEqual(listed(await recordsPage(env, "other")), [theirs.id]);
  assert.deepEqual(listed(await recordsPage(env, "quiet")), []);
  assert.match(await recordsPage(env, "quiet"), /This agent has kept no records yet\./);
  assert.doesNotMatch(await recordsPage(env, "quiet"), /<table/);
});

test("subject= narrows the list to one subject", async () => {
  const { env, bank } = fixture();
  const a = await createMandate(env, bank, { instruction_hash: h(1), action_hash: h(2), subject: "user:7" }, T0);
  const b = await createMandate(env, bank, { instruction_hash: h(3), action_hash: h(4), subject: "user:8" }, T0 + 1);
  const c = await createMandate(env, bank, { instruction_hash: h(5), action_hash: h(6) }, T0 + 2);
  assert.deepEqual(listed(await recordsPage(env, "bank")), [c.id, b.id, a.id]);
  const seven = await recordsPage(env, "bank", "user:7");
  assert.deepEqual(listed(seven), [a.id]);
  assert.match(seven, /The one record made for user:7 this agent has kept\./);
  assert.match(seven, /href="\/api\/mandates\?citizen=bank&amp;subject=user%3A7"/);
  assert.match(await recordsPage(env, "bank", "user:9"), /This agent has kept no records made for user:9\./);
  await assert.rejects(recordsPage(env, "bank", "<b>"), (e: unknown) => e instanceof SocietyError && e.status === 400);
});

test("a long list is cut at the cap and says so", async () => {
  const { env, bank } = fixture();
  const ids: number[] = [];
  for (let i = 0; i < RECORDS_PAGE + 1; i++) ids.push((await createMandate(env, bank, { instruction_hash: h(i + 1), action_hash: h(1000 + i) }, T0 + i)).id);
  const cut = await recentMandates(env, "bank");
  assert.equal(cut.more, true);
  assert.equal(cut.rows.length, RECORDS_PAGE);
  const page = await recordsPage(env, "bank");
  assert.deepEqual(listed(page), ids.slice(1).reverse(), "the oldest is the one left off");
  assert.ok(page.includes(`The ${RECORDS_PAGE} newest records, newest first. There are older ones; the full list is in the data below.`));
  assert.doesNotMatch(page, /All \d+ records/);
});

test("exactly the cap is the whole list, and says so", async () => {
  const { env, bank } = fixture();
  for (let i = 0; i < RECORDS_PAGE; i++) await createMandate(env, bank, { instruction_hash: h(i + 1), action_hash: h(1000 + i) }, T0 + i);
  const whole = await recentMandates(env, "bank");
  assert.equal(whole.more, false);
  assert.equal(whole.rows.length, RECORDS_PAGE);
  assert.ok((await recordsPage(env, "bank")).includes(`All ${RECORDS_PAGE} records this agent has kept, newest first.`));
  // The surface states the same cap, from the same constant, and never as a promise of that many.
  const route = SURFACE.find((r) => r.path === "/records/:handle")!;
  assert.ok(route.summary.includes(`up to ${RECORDS_PAGE} of its mandates, newest first`));
  assert.ok(route.summary.includes("When there are more, the page says so."));
});

test("one whole sentence for each case", () => {
  assert.equal(recordsCountSentence(0, false, null), "This agent has kept no records yet.");
  assert.equal(recordsCountSentence(0, false, "user:7"), "This agent has kept no records made for user:7.");
  assert.equal(recordsCountSentence(1, false, null), "The one record this agent has kept.");
  assert.equal(recordsCountSentence(1, false, "user:7"), "The one record made for user:7 this agent has kept.");
  assert.equal(recordsCountSentence(3, false, null), "All 3 records this agent has kept, newest first.");
  assert.equal(recordsCountSentence(3, false, "user:7"), "All 3 records made for user:7 this agent has kept, newest first.");
  assert.equal(recordsCountSentence(50, true, null), "The 50 newest records, newest first. There are older ones; the full list is in the data below.");
  assert.equal(recordsCountSentence(50, true, "user:7"), "The 50 newest records made for user:7, newest first. There are older ones; the full list is in the data below.");
});

test("a result added afterwards counts as recorded", async () => {
  const { env, bank } = fixture();
  const bare = await createMandate(env, bank, { instruction_hash: h(1), action_hash: h(2) }, T0);
  const atOnce = await createMandate(env, bank, { instruction_hash: h(3), action_hash: h(4), outcome_hash: h(5) }, T0 + 1);
  const later = await createMandate(env, bank, { instruction_hash: h(6), action_hash: h(7) }, T0 + 2);
  await addOutcome(env, bank, later.id, { outcome_hash: h(8) }, T0 + 3);
  const page = await recordsPage(env, "bank");
  assert.match(rowOf(page, bare.id), /<td>not yet<\/td>/);
  assert.match(rowOf(page, atOnce.id), /<td>recorded<\/td>/);
  assert.match(rowOf(page, later.id), /<td>recorded<\/td>/);
});

test("the list says how each record's text is kept", async () => {
  const { env, bank } = fixture();
  const secretText = "move the quarterly reserve to the new account";
  const open = await createMandate(env, bank, { instruction: "water the plants", action: "watered the plants", public: true }, T0);
  const prints = await createMandate(env, bank, { instruction_hash: h(1), action_hash: h(2) }, T0 + 1);
  const locked = await createMandate(env, bank, { instruction: secretText, action: "moved it", envelope: Buffer.from("age-encryption.org/v1\n-> X25519 abc\n--- mac\nciphertext").toString("base64") }, T0 + 2);
  const page = await recordsPage(env, "bank");
  assert.match(rowOf(page, open.id), /<td>public, readable by anyone<\/td>/);
  assert.match(rowOf(page, prints.id), /<td>private, fingerprints only<\/td>/);
  assert.match(rowOf(page, locked.id), /<td>private, text locked beside it<\/td>/);
  // A list is not a place a private instruction can appear, whatever was stored.
  assert.ok(!page.includes(secretText));
  assert.ok(!page.includes("water the plants"), "the list carries no text at all, public or not: the record's own page does");
});

test("the page is served, and refuses what it does not understand", async () => {
  const { env, bank } = fixture();
  const m = await createMandate(env, bank, { instruction_hash: h(1), action_hash: h(2) }, T0);
  const get = (path: string) => worker.fetch(new Request("https://1f916.ai" + path, { headers: { Accept: "text/html" } }), env as never);
  const ok = await get("/records/bank");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.deepEqual(listed(await ok.text()), [m.id]);
  assert.equal((await get("/records/nobody-here")).status, 404);
  assert.equal((await get("/records/bank?subjct=user:7")).status, 400, "a misspelled filter is refused, never silently the whole list");
  assert.equal((await get("/records/bank?subject=user:7")).status, 200);
  // A name that is not a handle's shape is not a route at all.
  assert.equal((await get("/records/%3Cscript%3E")).status, 404);
  assert.equal((await get("/records/a")).status, 404);
});
