// A cursor that names no row must not succeed as an empty complete page.
//
// Soft disclosure (200 + since_is_past_the_end) still answered HTTP 200 with
// count 0 and has_more false — the shape Cloudy-McCloud measured on #3770 when
// feeding a millisecond epoch into ?since=. A millisecond is all digits, so
// wholeNumber accepts it as a "row id"; left unguarded it is past every real
// event id and looks exactly like a caught-up cursor.
//
// The porch sibling refuses any since above MAX(id) with a 400 that names the
// unit (xinren F-0023 on #3357). Match that posture: past-the-end is refused,
// exhausted (since === newest id) still serves empty-complete, and the error
// names "row id from this log, not a timestamp".

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SocietyError, IDENTITY_LOG_PAGE, identityLog } from "../src/society.ts";

async function seed(rows: ReadonlyArray<{ kind: string; sealed?: boolean }>) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, ?, 'seed', ?, ?, ?)");
  rows.forEach((r, i) => insert.run(r.kind, i, r.sealed === false ? null : `p${i}`, r.sealed === false ? null : `h${i}`));
  return { DB: new SqliteD1(db) } as never;
}

const LOG = Array.from({ length: 12 }, () => ({ kind: "key-bind" }));

async function seedIds(ids: readonly number[]) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
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
  note: string;
};

function isPastEndRefusal(e: unknown, anchor: number): boolean {
  return (
    e instanceof SocietyError &&
    e.status === 400 &&
    e.message.includes(`since ${anchor}`) &&
    /row id from this log/.test(e.message) &&
    /not a timestamp/.test(e.message)
  );
}

test("an exhausted cursor still serves empty-complete; a past-the-end anchor is refused", async () => {
  const env = await seed(LOG);
  const caughtUp = (await identityLog(env, null, 12)) as unknown as Paged;
  assert.equal(caughtUp.count, 0, "the last row's id is the exhausted anchor");
  assert.equal(caughtUp.has_more, false);
  assert.equal(caughtUp.latest_event_id, 12);

  await assert.rejects(
    () => identityLog(env, null, 13),
    (e: unknown) => isPastEndRefusal(e, 13),
    "one past the last row must not succeed as empty-complete",
  );
});

test("a millisecond-epoch since is refused, naming the expected unit", async () => {
  // The board specimen: GET /api/events?since=<ms> answered 200 / count 0 /
  // has_more false because the timestamp was read as a row id past the end.
  const env = await seed(LOG);
  const ms = 1_725_543_480_000;
  await assert.rejects(
    () => identityLog(env, null, ms),
    (e: unknown) => isPastEndRefusal(e, ms),
  );
});

test("the refusal names the newest event id so a client can re-anchor", async () => {
  const env = await seed(LOG);
  await assert.rejects(
    () => identityLog(env, null, 99999999),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest event id \(12\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("a caught-up or in-range cursor is not refused", async () => {
  const env = await seed(LOG);
  for (const anchor of [0, 5, 12]) {
    const page = (await identityLog(env, null, anchor)) as unknown as Paged;
    assert.equal(page.latest_event_id, 12, `?since=${anchor} is inside the log`);
    assert.doesNotMatch(page.note, /YOUR ANCHOR NAMES NO ROW/);
  }
});

test("past-the-end is judged against the whole log, not the filtered subset", async () => {
  // since ranges over the log's id space. An id above the newest row OF THAT
  // KIND but inside the log is caught up, not refused. Rows 1-6 key-bind, 7-12
  // moderation.
  const env = await seed([
    ...Array.from({ length: 6 }, () => ({ kind: "key-bind" })),
    ...Array.from({ length: 6 }, () => ({ kind: "moderation" })),
  ]);
  const filtered = (await identityLog(env, "key-bind", 9)) as unknown as Paged;
  assert.equal(filtered.count, 0, "no key-bind rows exist above id 6");
  assert.equal(filtered.latest_event_id, 12, "the log's MAX(id), not the filter's");

  await assert.rejects(
    () => identityLog(env, "key-bind", 13),
    (e: unknown) => isPastEndRefusal(e, 13),
    "id 13 exists in no kind and must be refused on the filtered view too",
  );
});

test("an empty log accepts ?since=0 and refuses any positive anchor", async () => {
  const env = await seed([]);
  const start = (await identityLog(env, null, 0)) as unknown as Paged;
  assert.equal(start.latest_event_id, null, "no rows means no last id to name");
  assert.equal(start.count, 0);

  await assert.rejects(
    () => identityLog(env, null, 1),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest event id \(0\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("gapped ids: the ceiling is MAX(id), not COUNT(*)", async () => {
  const gapped = await seedIds([1, 2, 1000]);
  const page = (await identityLog(gapped, null, 1000)) as unknown as Paged;
  assert.equal(page.latest_event_id, 1000);
  assert.equal(page.count, 0, "exhausted at MAX(id)");

  await assert.rejects(
    () => identityLog(gapped, null, 1001),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest event id \(1000\)/.test(e.message),
  );
});

// GUARD for the CLASS, not for any one field.
//
// Every top-level key this endpoint can serve, on either branch, must have an
// entry in the published schema. A new field is a one-line schema edit away
// from green and cannot be forgotten.
test("every key /api/events serves across a swept argument space is documented, with the right type", async () => {
  const schema = JSON.parse(readFileSync(new URL("../schemas/events.json", import.meta.url), "utf8"));
  const documented = new Set(Object.keys(schema.properties));

  const logs: ReadonlyArray<[string, readonly { kind: string; sealed?: boolean }[]]> = [
    ["empty", []],
    ["small", LOG],
    ["over a page", Array.from({ length: IDENTITY_LOG_PAGE + 1 }, () => ({ kind: "key-bind" }))],
    ["two kinds", [...Array.from({ length: 6 }, () => ({ kind: "key-bind" })), ...Array.from({ length: 6 }, () => ({ kind: "moderation" }))]],
    ["an unsealed prefix", [...Array.from({ length: 4 }, () => ({ kind: "key-bind", sealed: false })), ...Array.from({ length: 4 }, () => ({ kind: "memory.seal" }))]],
  ];
  const filters = [null, "key-bind", "moderation", "key_rotation", "memory.seal", "no-such-kind"];
  const whose = [null, "li-nuwa", "no-such-citizen"];

  {
    const env = await seed(LOG);
    await assert.rejects(identityLog(env, "NOT A KIND!!", Number.NaN), (e: unknown) => (e as { status?: number }).status === 400);
    await assert.rejects(identityLog(env, null, 13), (e: unknown) => isPastEndRefusal(e, 13));
    await assert.rejects(identityLog(env, null, 1_725_543_480_000), (e: unknown) => isPastEndRefusal(e, 1_725_543_480_000));
  }

  const shapes: [string, object][] = [];
  for (const [logLabel, rows] of logs) {
    const env = await seed(rows);
    // Past-the-end anchors are refused; pick in-range / exhausted values per log.
    const maxId = rows.length;
    const anchors = maxId === 0 ? [Number.NaN, 0] : [Number.NaN, 0, Math.min(5, maxId), maxId];
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
  const reached = (p: (b: Record<string, unknown>) => boolean) => shapes.some(([, b]) => p(b as Record<string, unknown>));
  assert.ok(reached((b) => b.has_more === true && b.order !== undefined), "the paged view with a page still to come is reached");
  assert.ok(reached((b) => b.latest_event_id === null), "the empty log is reached");
  assert.ok(reached((b) => b.order === undefined), "the default DESC branch is reached");
  assert.ok(reached((b) => b.citizen_filter_is_a_known_citizen === true), "a resolved citizen filter is reached");
  assert.ok(reached((b) => b.citizen_filter_is_a_known_citizen === false), "a citizen filter naming nobody is reached");
  assert.ok(
    reached((b) => b.order !== undefined && b.count === 0 && b.has_more === false && b.latest_event_id !== null),
    "exhausted in-range cursor (empty complete page) is reached",
  );

  for (const [label, body] of shapes) {
    const undocumented = Object.keys(body).filter((k) => !documented.has(k));
    assert.deepEqual(undocumented, [], `${label} serves ${undocumented.join(", ")}, which schemas/events.json does not describe`);
  }

  const servable = new Set(shapes.flatMap(([, body]) => Object.keys(body)));
  for (const key of ["now", "now_utc"]) servable.add(key);
  const phantom = [...documented].filter((k) => !servable.has(k));
  assert.deepEqual(
    phantom,
    [],
    `schemas/events.json describes ${phantom.join(", ")}, which no shape above serves. ADD THE SHAPE THAT SERVES IT to logs/filters/anchors above; only delete the schema entry if the field really is gone.`,
  );

  const declared: Record<string, unknown> = {
    latest_event_id: ["integer", "null"],
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
  assert.equal(schema.properties.since_is_past_the_end, undefined, "past-the-end is a 400 now; the soft field must not remain documented");

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
