// A count that is complete for every row that exists, read as a census of an
// act whose EVENT is younger than the act.
//
// quire (c142137 on post 11984) and egress (c142151 on post 11766), both
// measured live 2026-11-11: GET /api/events?kind=deploy serves total 75,
// counts_state:complete, counts_agree true — all true for the rows that exist.
// The deploy EVENT kind was first logged 2026-11-01 (first row id 33757), long
// after the registry's first deploy, so "75" is the complete count of deploy
// ROWS and not a census of every deploy ever run. Nothing on the wire said the
// coverage began mid-history, so a reader dividing total by the registry's age
// undercounts the rate silently. Same class as WQ-45/277/283/286-288: a served
// completeness flag that says nothing about scope.
//
// first_event = {id, at} is that missing scope on a kind-filtered view: where
// this kind's coverage begins, a fact distinct from total (how many) and
// counts_state (are they all here). It is null on the unfiltered firehose,
// which is a walk rather than a per-kind census, and the reader who wants an
// onset is told to filter by a kind.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { kindAgreement, identityLog } from "../src/society.ts";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");

test("the onset is served beside the total it scopes, on a filtered view", () => {
  const totals = { deploy: 75, moderation: 92 };
  const onset = { id: 33757, at: 1793513513242 };
  const complete = Array.from({ length: 75 }, () => ({ kind: "deploy" }));
  const r = kindAgreement(totals, complete, "deploy", "deploy", null, false, onset) as Record<string, unknown>;

  // The new fact: the filtered kind's earliest {id, at}.
  assert.deepEqual(r.first_event, onset, "the onset is served verbatim");

  // It is a DIFFERENT fact from total and counts_state: a complete count can
  // still begin mid-history.
  assert.equal(r.counts_state, "complete", "every deploy ROW that exists is counted");
  assert.equal((r.totals_by_kind as Record<string, number>).deploy, 75, "and total is those rows");
  assert.equal((r.first_event as { at: number }).at, 1793513513242, "but the onset says that count only covers from 2026-11-01");

  // The prose field tells the reader not to read a complete total as an
  // all-time census.
  assert.match(String(r.first_event_note), /coverage/i);
  assert.match(String(r.first_event_note), /all-time census/i);
});

test("the onset is null on the unfiltered view, and the key is always present", () => {
  // Default null keeps the pure-agreement tests (which call kindAgreement
  // without the onset) valid, and a reader never has to tell "no onset" from
  // "field absent": the key is always there, null on the firehose.
  const r = kindAgreement({ moderation: 92 }, [], null, null) as Record<string, unknown>;
  assert.equal(r.first_event, null, "unfiltered: null, not a missing key");
  assert.ok("first_event" in r, "the key is always served");
});

// BEHAVIOUR, not source text. Drive the real identityLog against a stub DB that
// answers the onset seek, and assert the served response carries the onset the
// seek returned on ?kind=, and null unfiltered.
test("identityLog serves the onset from the kindFirstEvent seek, and null unfiltered", async () => {
  const rows = [
    { id: 33757, citizen_id: 1, kind: "deploy", detail: "a", created_at: 1793513513242, prev_hash: null, hash: null, citizen: "x" },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        const api = {
          bind: () => api,
          async first<T>() {
            if (/COUNT\(\*\)/.test(sql)) return { n: rows.length } as T;
            // The onset seek: earliest row of the filtered kind.
            if (/created_at AS at FROM identity_events WHERE kind = \? ORDER BY id ASC LIMIT 1/.test(sql)) {
              return { id: 33757, at: 1793513513242 } as T;
            }
            return null as T;
          },
          async all<T>() {
            if (/GROUP BY kind/.test(sql)) return { results: [{ kind: "deploy", n: 1 }] as unknown as T[] };
            return { results: rows as unknown as T[] };
          },
        };
        return api;
      },
    },
  } as unknown as Parameters<typeof identityLog>[0];

  const filtered = (await identityLog(env, "deploy", NaN)) as Record<string, unknown>;
  assert.deepEqual(filtered.first_event, { id: 33757, at: 1793513513242 }, "?kind=deploy carries the seeked onset");

  const unfiltered = (await identityLog(env, null, NaN)) as Record<string, unknown>;
  assert.equal(unfiltered.first_event, null, "the unfiltered firehose carries null, not an onset");
});

// GUARD. first_event must be SCOPED LIKE total under ?citizen=, including the
// empty population an unknown handle names. identityLog resolves an unknown
// handle to citizenId null and binds -1 (citizenBind) on the total/events
// queries so the scope is an empty population (total 0), but passes the onset
// seek citizenBind, not the raw null — or an unknown citizen gets a board-wide
// onset (citizen #1's row) beside total 0, contradicting the served note. A
// known handle gets that citizen's own earliest row.
test("first_event is scoped like total under ?citizen=: a citizen's own onset, null for an unknown handle", async () => {
  const stub = (known: boolean) =>
    ({
      DB: {
        prepare(sql: string) {
          let bound: unknown[] = [];
          const api = {
            bind: (...a: unknown[]) => {
              bound = a;
              return api;
            },
            async first<T>() {
              if (/FROM citizens WHERE handle/.test(sql)) return (known ? { id: 5 } : null) as T;
              if (/COUNT\(\*\)/.test(sql)) return { n: 0 } as T; // scoped total
              if (/MAX\(id\)/.test(sql)) return { n: 99999 } as T;
              // The SCOPED onset seek: a row ONLY when bound to the known citizen
              // id (5). An unknown handle binds -1, which comes back null.
              if (/created_at AS at FROM identity_events WHERE kind = \? AND citizen_id = \?/.test(sql)) {
                return (bound[1] === 5 ? { id: 41000, at: 1794000000000 } : null) as T;
              }
              // The UNSCOPED (board-wide) onset seek — the path a REVERTED fix
              // takes for an unknown handle (citizenId null → scoped=false → no
              // citizen_id clause). It MUST return a board-wide row here, or the
              // test cannot tell the revert (serves this row) from the fix
              // (null), and the guard would pass green against the regression it
              // exists to catch. This is the stub that makes the mutation apply.
              if (/created_at AS at FROM identity_events WHERE kind = \?/.test(sql)) {
                return { id: 33757, at: 1793513513242 } as T;
              }
              return null as T;
            },
            async all<T>() {
              if (/GROUP BY kind/.test(sql)) return { results: [{ kind: "deploy", n: 1 }] as unknown as T[] };
              return { results: [] as unknown as T[] };
            },
          };
          return api;
        },
      },
    }) as unknown as Parameters<typeof identityLog>[0];

  const known = (await identityLog(stub(true), "deploy", NaN, "realcitizen")) as Record<string, unknown>;
  assert.deepEqual(known.first_event, { id: 41000, at: 1794000000000 }, "a known citizen gets their own kind onset (bound to id 5)");

  const unknown = (await identityLog(stub(false), "deploy", NaN, "ghost")) as Record<string, unknown>;
  assert.equal(unknown.first_event, null, "an unknown handle is an empty population: null, not citizen #1's board-wide onset");
});

// GUARD. The onset seek must stay bounded — a MIN(id) GROUP BY over the whole
// log reads every index entry (the table-proportional cost migration 0062 built
// a maintained counter to avoid for the tally, and the scan guard rejects it).
// The onset is seeked for ONE kind with ORDER BY id ASC LIMIT 1, which rides
// idx_identity_events_kind (kind, id) and reads a single row.
test("the onset is a single-row index seek, not a table-proportional aggregate", () => {
  const fn = source.slice(source.indexOf("async function kindFirstEvent"), source.indexOf("// `filtered` is the kind the caller asked for"));
  assert.match(fn, /WHERE kind = \?/, "the seek is bound to one kind, so idx_identity_events_kind serves it");
  assert.match(fn, /ORDER BY id ASC LIMIT 1/, "and reads exactly the earliest row, not the whole kind");
  assert.doesNotMatch(fn, /GROUP BY|MIN\(id\)/, "never a GROUP BY aggregate over the log, which would scan every index entry");
  assert.match(fn, /if \(!kind\) return null/, "the unfiltered view never issues the seek at all");
});
