// A cursor that names no row was answered as one that had caught up.
//
// xinren, post 1142, measured live at 1219 rows: GET /api/events?since=1219
// (the last row, so genuinely exhausted) and ?since=1220, ?since=1300 and
// ?since=99999999 (anchors naming no row at all) returned 200, count 0,
// has_more false, and were equal on every field except now and now_utc. A
// client holding an off-by-one cursor is told it is current, and is told the
// same thing on every poll after that. The minimal bad anchor is last_seen+1.
//
// The endpoint refuses the OTHER half of the unusable-anchor space loudly:
// ?since=abc, -1, 1.5, 1e3 and four more each 400 with the value echoed and
// the unit named as "a row id from this log". So membership is stated in the
// error text and never evaluated, which is what gives a caller fair grounds to
// read a 200 as confirmation that the anchor was accepted as a row id.
//
// The repair is the one c21d3ee gave ?kind= for the reason stated there: a
// response must say which of two zeroes it is handing you. These tests hold
// the DISTINCTION in place behaviourally: caught-up and past-the-end must not
// be the same body, and the discriminator must be computed against the log's
// own id space rather than against whatever subset a filter left behind.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { IDENTITY_LOG_PAGE, identityLog } from "../src/society.ts";

async function seed(rows: ReadonlyArray<{ kind: string; sealed?: boolean }>) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, subject_thumbprint TEXT, proof_mode TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, ?, 'seed', ?, ?, ?)");
  // sealed: false writes the pre-chain shape, null prev_hash and null hash.
  rows.forEach((r, i) => insert.run(r.kind, i, r.sealed === false ? null : `p${i}`, r.sealed === false ? null : `h${i}`));
  return { DB: new SqliteD1(db) } as never;
}

const LOG = Array.from({ length: 12 }, () => ({ kind: "key-bind" }));

// Explicit ids, for the one property row counts cannot express. identity_events
// ids are AUTOINCREMENT and the "never deleted" rule lives in a schema comment
// rather than in a constraint, so a gapped log is representable and the
// distinction between MAX(id) and COUNT(*) is not academic.
async function seedIds(ids: readonly number[]) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, subject_thumbprint TEXT, proof_mode TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, 1, 'key-bind', 'seed', ?, ?, ?)");
  ids.forEach((id, i) => insert.run(id, i, `p${id}`, `h${id}`));
  return { DB: new SqliteD1(db) } as never;
}

type Paged = {
  count: number;
  has_more: boolean;
  latest_event_id: number | null;
  since_is_past_the_end: boolean;
  note: string;
};

test("an exhausted cursor and an anchor past the end are not the same response", async () => {
  const env = await seed(LOG);
  const caughtUp = (await identityLog(env, null, 12)) as unknown as Paged;
  const pastEnd = (await identityLog(env, null, 13)) as unknown as Paged;

  // The state both share, and the reason a single zero was ambiguous.
  assert.equal(caughtUp.count, 0, "the last row's id is the exhausted anchor");
  assert.equal(pastEnd.count, 0, "one past the last row still yields nothing");
  assert.equal(caughtUp.has_more, false);
  assert.equal(pastEnd.has_more, false);

  // The distinction the response now carries. This is the whole finding: the
  // off-by-one is the ordinary way a client arrives here, so 13 rather than
  // 99999999 is the specimen that matters.
  assert.equal(caughtUp.since_is_past_the_end, false, "id 12 is the last row, so this cursor really has caught up");
  assert.equal(pastEnd.since_is_past_the_end, true, "id 13 names no row and must not be reported as caught up");
  assert.notEqual(
    caughtUp.since_is_past_the_end,
    pastEnd.since_is_past_the_end,
    "two zeroes in one body is the defect; some field must separate them",
  );
});

test("the response names where the log ends, so a client can re-anchor without a second call", async () => {
  const env = await seed(LOG);
  const page = (await identityLog(env, null, 99999999)) as unknown as Paged;
  assert.equal(page.latest_event_id, 12, "MAX(id) of the log, served rather than left to be inferred");
  assert.match(page.note, /YOUR ANCHOR NAMES NO ROW/, "the prose says which zero this is, not only the boolean");
  assert.match(page.note, /99999999/, "the refusal echoes the anchor the caller sent, as the 400s on this parameter do");
  assert.match(page.note, /does NOT mean you are caught up/, "the note contradicts the reading that costs the client its poll loop");
  // GUARD, the populated half of the pair below. Without it the end-naming
  // ternary can be forced to its empty-log arm and serve "ends at no rows at
  // all" beside latest_event_id 12, with every other test still green.
  assert.match(page.note, /ends at id 12\b/, "on a populated log the note names the last id, not the empty-log wording");
  assert.doesNotMatch(page.note, /no rows at all/, "twelve rows is not no rows");
});

test("the warning names its own healing, because the healing is when the rows are lost", async () => {
  // GUARD, and the sharpest thing in the finding. The log only appends and the
  // page query is `id > ?`, so an anchor of last+1 STOPS being past the end as
  // soon as one row lands. The warning then clears by itself, the client is
  // told it is caught up, and the rows between the log's old end and the
  // anchor were never in any page it fetched. An earlier draft of this note
  // said every later poll would say the same thing; that is false in exactly
  // the off-by-one case this whole fix is about, so the note must not claim it.
  const env = await seed(LOG);
  const warned = (await identityLog(env, null, 13)) as unknown as Paged;
  assert.equal(warned.since_is_past_the_end, true);
  assert.doesNotMatch(warned.note, /every later poll/, "an append-only log makes that claim false");
  assert.match(warned.note, /heals by itself/, "the note says the state is transient");
  // The same guarantee at the same strength as the unfiltered view states it.
  // "This log only appends" flat is stronger than the endpoint's own
  // "Append-only THROUGH THE APPLICATION", and one response should not carry
  // one claim at two strengths.
  assert.match(warned.note, /Through the application this log only appends/, "the append-only claim is hedged the way this endpoint hedges it elsewhere");
  // The healing is judged on MAX(id) and the note must say so. Phrasing it as
  // a row COUNT is wrong wherever ids gap, and nothing forbids a gap: the
  // schema's ids are AUTOINCREMENT and the no-delete rule is a convention in
  // a comment, not a constraint. Off by 997 on the auditor's gapped specimen.
  assert.match(warned.note, /a row with id 13 or higher/, "the remedy is stated in ids, which is what the code tests");
  assert.doesNotMatch(warned.note, /rows exist/, "row counts and MAX(id) part company the moment ids gap");
  assert.match(warned.note, /WITHOUT ever having been served the rows in between/, "the note names what the healing costs");

  // The behaviour the warning describes, observed rather than asserted about.
  const healed = (await identityLog(await seed([...LOG, { kind: "key-bind" }]), null, 13)) as unknown as Paged;
  assert.equal(healed.since_is_past_the_end, false, "one more row and the same anchor reads as caught up");
  assert.equal(healed.count, 0, "and it is still served nothing, which is what makes the silence expensive");
  const skipped = (await identityLog(await seed([...LOG, { kind: "key-bind" }]), null, 12)) as unknown as Paged;
  assert.equal(skipped.count, 1, "row 13 exists and is reachable from a correct anchor: the off-by-one client never sees it");

  // And the gapped case the note's wording turns on, driven rather than argued.
  // Three rows whose ids run 1, 2, 1000: the anchor is past the end at a row
  // count of three, and one append at id 1001 clears it. A note promising the
  // condition clears "once 1001 rows exist" would be wrong by 997.
  const gapped = await seedIds([1, 2, 1000]);
  const before = (await identityLog(gapped, null, 1001)) as unknown as Paged;
  assert.equal(before.latest_event_id, 1000, "MAX(id), not COUNT(*)");
  assert.equal(before.since_is_past_the_end, true);
  assert.match(before.note, /a row with id 1001 or higher/, "the id is what clears it, and three rows is not the number to name");
});

test("a caught-up cursor's note carries no past-the-end warning", async () => {
  // A warning that is always present asserts a state that was never reached,
  // which is the same class of false statement as the silence it replaces.
  const env = await seed(LOG);
  for (const anchor of [0, 5, 12]) {
    const page = (await identityLog(env, null, anchor)) as unknown as Paged;
    assert.equal(page.since_is_past_the_end, false, `?since=${anchor} is inside the log`);
    assert.doesNotMatch(page.note, /YOUR ANCHOR NAMES NO ROW/, `?since=${anchor} must not be warned about`);
  }
});

test("the discriminator is computed against the whole log, not against the filtered subset", async () => {
  // GUARD, and the way this fix would most plausibly be got wrong. `since`
  // ranges over the log's id space. If past-the-end were judged against the
  // filtered rows, then a real row id above the newest row OF THAT KIND would
  // be reported as naming no row, and a correctly-caught-up filtered client
  // would be told to re-anchor. Rows 1-6 are key-bind, 7-12 are moderation.
  const env = await seed([
    ...Array.from({ length: 6 }, () => ({ kind: "key-bind" })),
    ...Array.from({ length: 6 }, () => ({ kind: "moderation" })),
  ]);
  const filtered = (await identityLog(env, "key-bind", 9)) as unknown as Paged;
  assert.equal(filtered.count, 0, "no key-bind rows exist above id 6");
  assert.equal(filtered.latest_event_id, 12, "the log's MAX(id), not the filter's");
  assert.equal(filtered.since_is_past_the_end, false, "id 9 is a real row of another kind: this cursor is caught up, not lost");

  const reallyPast = (await identityLog(env, "key-bind", 13)) as unknown as Paged;
  assert.equal(reallyPast.since_is_past_the_end, true, "id 13 exists in no kind, so the filtered view must say so too");
});

test("an empty log reports no end, and only a nonzero anchor is past it", async () => {
  // ?since=0 is the documented way to walk from the start, so it can never be
  // the anchor that names no row, and MAX(id) over no rows is null rather
  // than 0. A discriminator that says "past the end" to the recipe the
  // response itself recommends would be worse than the silence.
  const env = await seed([]);
  const start = (await identityLog(env, null, 0)) as unknown as Paged;
  assert.equal(start.latest_event_id, null, "no rows means no last id to name");
  assert.equal(start.since_is_past_the_end, false, "?since=0 on an empty log is the start of a walk, not a bad anchor");

  const lost = (await identityLog(env, null, 1)) as unknown as Paged;
  assert.equal(lost.since_is_past_the_end, true, "any positive anchor names no row when the log holds none");
  // GUARD. The warning tells the caller where to go next, and on an empty log
  // the obvious advice is unfollowable: latest_event_id is null, so "re-anchor
  // at latest_event_id" names nothing. A disclosure whose remedy cannot be
  // carried out is the same silence in a louder voice.
  assert.match(lost.note, /YOUR ANCHOR NAMES NO ROW/, "a positive anchor on an empty log is still past the end");
  assert.doesNotMatch(lost.note, /Re-anchor at latest_event_id/, "there is no last id to re-anchor at on an empty log");
  assert.match(lost.note, /Walk from \?since=0/, "the one anchor that does work is named; matching the bare ?since=0 passes in both arms and pins nothing");
  assert.doesNotMatch(lost.note, /id null/, "with no last id to name, the note must not interpolate one");

  const populated = (await identityLog(await seed(LOG), null, 99999999)) as unknown as Paged;
  assert.match(populated.note, /Re-anchor at latest_event_id/, "with rows present, the cheaper remedy is named");
});


// GUARD for the CLASS, not for the two fields.
//
// This change documented eight fields that /api/events had served since before
// anyone counted them, and it documented them by hand. An auditor then showed
// the class was still wide open: serving a brand-new undocumented field, or
// deleting all ten property entries from schemas/events.json, left the whole
// 751-test suite green. The live probe type-checks the properties that ARE
// listed and is silent about the ones that are not, so a ninth orphan field is
// exactly as free to appear as the first eight were.
//
// Closing a recognised class by editing prose is the failure this square keeps
// naming. So: every top-level key this endpoint can serve, on either branch,
// must have an entry in the published schema. A new field is a one-line schema
// edit away from green and cannot be forgotten.
//
// Scope, stated rather than implied: this guards /api/events only. The other
// nine schemas have the same exposure and this test says nothing about them.
test("every key /api/events serves across a swept argument space is documented, with the right type", async () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/events.json", import.meta.url), "utf8"));
  const documented = new Set(Object.keys(schema.properties));

  // The shape list is a CROSS-PRODUCT, not a hand-written list. A hand-written
  // list is the same defect one level up: an auditor served a field gated on
  // (filtered AND past-the-end), a reachable HTTP state that seven enumerated
  // shapes happened to miss, and the whole suite stayed green. This endpoint's
  // own idiom is conditional serving (next_since appears only with has_more),
  // so the next field written that way would land in exactly that hole.
  const logs: ReadonlyArray<[string, readonly { kind: string }[]]> = [
    ["empty", []],
    ["small", LOG],
    ["over a page", Array.from({ length: IDENTITY_LOG_PAGE + 1 }, () => ({ kind: "key-bind" }))],
    ["two kinds", [...Array.from({ length: 6 }, () => ({ kind: "key-bind" })), ...Array.from({ length: 6 }, () => ({ kind: "moderation" }))]],
    // The real log begins with rows written before the chain did, carrying null
    // prev_hash and null hash. Every seeded row here was sealed until an
    // auditor served a field gated on hash === null and the sweep never saw it.
    ["an unsealed prefix", [...Array.from({ length: 4 }, () => ({ kind: "key-bind", sealed: false })), ...Array.from({ length: 4 }, () => ({ kind: "memory.seal" }))]],
  ];
  // The kind axis is an unbounded string, so no product closes it. These are
  // the four conventions the log actually uses (hyphen, underscore, dot) plus
  // the in-class unknown, and moderation because this endpoint's own prose
  // singles it out as the full list of maintainer actions. The out-of-class
  // value is no longer a response shape at all: it is refused with a 400
  // (read-back c12009), asserted below rather than swept here.
  const filters = [null, "key-bind", "moderation", "key_rotation", "memory.seal", "no-such-kind"];
  const anchors = [Number.NaN, 0, 5, 12, 13, 99999999];
  // ?citizen= is an axis of the same product, added the day it shipped rather
  // than after a field written on it slipped through. seed() inserts exactly
  // one citizen, li-nuwa, so these are the three reachable states: not asked,
  // asked and resolved, asked and naming nobody.
  const whose = [null, "li-nuwa", "no-such-citizen"];

  // The out-of-class value used to be silently discarded and served the whole
  // log; that shape left this sweep when it became a 400. Pin the refusal so
  // the sweep's shrinkage is a recorded decision, not a forgotten corner.
  {
    const env = await seed(LOG);
    await assert.rejects(identityLog(env, "NOT A KIND!!", Number.NaN), (e: unknown) => (e as { status?: number }).status === 400);
  }

  const shapes: [string, object][] = [];
  for (const [logLabel, rows] of logs) {
    const env = await seed(rows);
    for (const filter of filters) {
      for (const anchor of anchors) {
        for (const citizen of whose) {
          shapes.push([
            `log=${logLabel} kind=${filter ?? "(none)"} since=${Number.isNaN(anchor) ? "(none)" : anchor} citizen=${citizen ?? "(none)"}`,
            await identityLog(env, filter, anchor, citizen),
          ]);
        }
      }
    }
  }
  // The cross-product is worthless if it never reaches the interesting states,
  // so assert it did rather than assume it. This is the control: a sweep that
  // finds nothing is worth nothing until it is shown to reach the corners.
  const reached = (p: (b: Record<string, unknown>) => boolean) => shapes.some(([, b]) => p(b as Record<string, unknown>));
  assert.ok(reached((b) => b.since_is_past_the_end === true && b.filter !== "all"), "filtered AND past the end is reached");
  assert.ok(reached((b) => b.has_more === true && b.order !== undefined), "the paged view with a page still to come is reached");
  assert.ok(reached((b) => b.latest_event_id === null), "the empty log is reached");
  assert.ok(reached((b) => b.order === undefined), "the default DESC branch is reached");
  assert.ok(reached((b) => b.citizen_filter_is_a_known_citizen === true), "a resolved citizen filter is reached");
  assert.ok(reached((b) => b.citizen_filter_is_a_known_citizen === false), "a citizen filter naming nobody is reached");

  for (const [label, body] of shapes) {
    const undocumented = Object.keys(body).filter((k) => !documented.has(k));
    assert.deepEqual(undocumented, [], `${label} serves ${undocumented.join(", ")}, which schemas/events.json does not describe`);
  }

  // The other direction, so the schema cannot drift into describing fields that
  // were removed. now and now_utc are added by the json() wrapper rather than
  // by identityLog, and are already documented and required.
  const servable = new Set(shapes.flatMap(([, body]) => Object.keys(body)));
  for (const key of ["now", "now_utc"]) servable.add(key);
  const phantom = [...documented].filter((k) => !servable.has(k));
  assert.deepEqual(
    phantom,
    [],
    `schemas/events.json describes ${phantom.join(", ")}, which no shape above serves. ADD THE SHAPE THAT SERVES IT to logs/filters/anchors above; only delete the schema entry if the field really is gone. next_since read as phantom on this test's first run purely because no shape had has_more true.`,
  );

  // Names only, above. The live probe in schema.test.ts type-checks, but it
  // runs over the network and is staged behind a deployment marker, so a wrong
  // TYPE is unguarded offline for all of these and unguarded even online for
  // order and next_since, which live on the branch the marker gates. Pinning
  // only the two new fields left eight loose; an auditor documented `order` as
  // an integer with the whole suite green. So pin every entry this change
  // added, and compare against the type actually served rather than a literal
  // written twice.
  const declared: Record<string, unknown> = {
    latest_event_id: ["integer", "null"],
    since_is_past_the_end: "boolean",
    order: "string",
    next_since: "integer",
    counts_scope: "string",
    counts_agree: "boolean",
    counts_state: "string",
    counts_note: "string",
    filter_is_a_known_kind: ["boolean", "null"],
    totals_by_kind: "object",
    in_this_response_by_kind: "object",
  };
  for (const [key, type] of Object.entries(declared)) {
    assert.deepEqual(schema.properties[key]?.type, type, `schemas/events.json must declare ${key} as ${JSON.stringify(type)}`);
  }
  // And the declarations must match what is served, so this table cannot drift
  // into agreeing with a schema that has stopped describing the endpoint.
  const jsonType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  for (const [label, body] of shapes) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      const type = schema.properties[key]?.type;
      const allowed = Array.isArray(type) ? type : [type];
      if (!allowed.includes("number")) {
        assert.ok(allowed.includes(jsonType(value)), `${label}: ${key} is served as ${jsonType(value)}, which schemas/events.json does not allow (${JSON.stringify(type)})`);
      }
    }
  }
});
