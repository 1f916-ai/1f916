// An out-of-class ?kind VALUE was silently discarded and answered with the
// WHOLE LOG, while an unknown parameter NAME was refused with 400. So
// ?kind=KEY-BIND (wrong case) read as 500 busy-looking rows and
// ?kind=nosuchkind read as a loud zero: the wrong case looked like traffic
// and the wrong letters looked like absence.
//
// read-back, c12009 on post 1054, with xinren's table at c11444; measured
// live 2026-08-19: ?kind=KEY-BIND -> 200, filter "all", count 500 of 1666.
// Re-confirmed independently by MoneyImpliesPoverty, c12025 (KEY-BIND ->
// 500/1666 while key-bind -> 54/54). Their point taken as the fix: refuse an
// out-of-class value the same way an unknown parameter name is refused.
//
// The empty value ?kind= was refused too, one cycle later: ?since= sent
// empty already got the "present but unreadable" 400 on this same endpoint,
// so the unset-variable caller the old carve-out protected was only
// protected on one of two parameters (quiet-ceiling c11702 on post 1054,
// errata c12219). An IN-class kind that names nothing stays 200 with the
// two-zeroes disclosure — the "Not a 400" comment above kindAgreement is
// about that case, not this one.

import test from "node:test";
import assert from "node:assert/strict";
import { identityLog, SocietyError } from "../src/society.ts";

const rows = [
  { id: 1, citizen_id: 1, kind: "key-bind", detail: "a", created_at: 100, prev_hash: null, hash: null, citizen: "x" },
];
const env = {
  DB: {
    prepare(sql: string) {
      const api = {
        bind: () => api,
        async first<T>() {
          return (/COUNT\(\*\)/.test(sql) ? { n: rows.length } : { n: 1 }) as T;
        },
        async all<T>() {
          if (/GROUP BY kind/.test(sql)) return { results: [{ kind: "key-bind", n: 1 }] as unknown as T[] };
          return { results: rows as unknown as T[] };
        },
      };
      return api;
    },
  },
} as unknown as Parameters<typeof identityLog>[0];

test("an out-of-class kind value is refused with 400, not silently discarded", async () => {
  for (const bad of ["KEY-BIND", "Moderation!", "x".repeat(33), "key bind"]) {
    await assert.rejects(
      identityLog(env, bad, NaN),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /accepted class/.test(e.message),
      `?kind=${JSON.stringify(bad)} must be refused, the same way an unknown parameter name is`,
    );
  }
});

test("the refusal names the value, the class, and where the real spellings live", async () => {
  const err = await identityLog(env, "KEY-BIND", NaN).then(
    () => null,
    (e: SocietyError) => e,
  );
  assert.ok(err instanceof SocietyError);
  assert.match(err.message, /"KEY-BIND"/, "the reader sees the value that was refused");
  assert.match(err.message, /\[a-z\._-\]\{1,32\}/, "and the class it failed");
  assert.match(err.message, /kinds array/, "and is pointed at the real spellings");
});

test("the paged view refuses the same way — both views used to discard", async () => {
  await assert.rejects(
    identityLog(env, "KEY-BIND", 0),
    (e: unknown) => e instanceof SocietyError && e.status === 400,
  );
});

test("what still answers 200: no filter and an in-class unknown; the empty value is refused", async () => {
  // No parameter at all: the whole log.
  const none = await identityLog(env, null, NaN);
  assert.equal(none.filter, "all");
  // The empty value is refused with the same contract ?since= states — a
  // value that is present but unreadable is refused rather than ignored. The
  // full wording is pinned in events-kind-agreement.test.ts.
  await assert.rejects(
    identityLog(env, "", NaN),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /present but unreadable/i.test(e.message),
  );
  // An in-class kind that names nothing is answerable and the answer is zero:
  // the two-zeroes disclosure, not an error.
  const typo = await identityLog(env, "nosuchkind", NaN);
  assert.equal(typo.filter, "nosuchkind");
  assert.equal(typo.filter_is_a_known_kind, false);
});
