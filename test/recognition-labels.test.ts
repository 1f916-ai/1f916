// A dated measurement is only legitimate because it is LABELLED, and until this
// file nothing checked the label.
//
// Two figures in the recognition block cannot be derived from a balance: how
// much one sender has cumulatively sent, and how much was given deliberately.
// Both need a walk of hundreds of ranged eth_getLogs calls, which an anonymous
// GET may not cost this society. So they are typed constants on a page whose
// entire discipline is that quantities are computed, and the ONLY thing that
// makes that acceptable is `as_of`, `method`, and `live: false` on the wire.
//
// The pre-deploy auditor ran six mutations against the full 794-test suite on
// 2026-08-21. All six passed green: strip the `measured` object off the served
// entry, flip `live: false` to true, delete `as_of` from the constant, strip
// `given_deliberately.measured`, delete `recognition_is_not_endorsement`, and
// delete the promotion/placement ban from standing_rules. A dated measurement
// could silently lose its date and ship. That is "never collected" with the
// serial numbers filed off, and closing it with care rather than a guard is
// what this repo has already learned does not work.

import test from "node:test";
import assert from "node:assert/strict";
import { MEASURED } from "../src/assets.ts";
import { treasury, type Env } from "../src/society.ts";

const TREASURY = "0x0000000000000000000000000000000000000041";
const stubEnv = () =>
  ({
    DB: {
      prepare(sql: string) {
        return {
          async all<T>() {
            return { results: [] as T[] };
          },
          async first<T>() {
            if (sql.includes("SUM(amount_cents)")) return { balance: 0 } as T;
            return { n: 0 } as T;
          },
        };
      },
    },
    TREASURY_ADDRESS: TREASURY,
    BASE_RPC_URL: "https://rpc.test",
  }) as unknown as Env;

test("every MEASURED entry carries the date and the walk that produced it", () => {
  const entries = Object.entries(MEASURED as Record<string, Record<string, unknown>>);
  assert.ok(entries.length > 0, "the constant exists to be labelled; an empty one is a silent removal");
  for (const [name, entry] of entries) {
    assert.equal(typeof entry.as_of, "string", `MEASURED.${name} must say WHEN it was measured`);
    assert.match(
      String(entry.as_of),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/,
      `MEASURED.${name}.as_of must be a real instant, not a placeholder — an earlier draft shipped "05:2xZ"`,
    );
    assert.equal(typeof entry.method, "string", `MEASURED.${name} must say HOW`);
    assert.ok(
      String(entry.method).length > 80,
      `MEASURED.${name}.method must be re-runnable by a stranger, not a word`,
    );
  }
});

test("a measured figure is served as measured, and the endorsement boundary is served at all", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Every provider down. The labels are structural and must survive the
    // degraded path, which is the path where a reader most needs them.
    globalThis.fetch = (async () => {
      throw new Error("provider unreachable");
    }) as unknown as typeof fetch;

    const body = await treasury(stubEnv());
    const policy = body.spending_policy as Record<string, unknown>;
    const rec = policy.recognition as {
      tokens: Array<Record<string, unknown>>;
      given_deliberately: Record<string, unknown>;
    };

    const measuredTokens = rec.tokens.filter((t) => t.live === false);
    assert.equal(measuredTokens.length, 1, "exactly one served token entry is a measurement, and it must say so");
    for (const t of measuredTokens) {
      const m = t.measured as Record<string, unknown> | undefined;
      assert.ok(m, "a token entry marked live:false must carry its measured block");
      assert.equal(typeof m.as_of, "string");
      assert.equal(typeof m.method, "string");
    }
    for (const t of rec.tokens.filter((x) => x.live === true)) {
      assert.ok(!("measured" in t), "a live entry must not claim to be a measurement");
    }

    const gd = rec.given_deliberately.measured as Record<string, unknown> | undefined;
    assert.ok(gd, "given_deliberately is a walk, not a balance, and must carry its receipt");
    assert.equal(typeof gd.as_of, "string");
    assert.equal(typeof gd.method, "string");

    // The boundary itself. Recognition without it is an endorsement with extra
    // steps, and the auditor deleted this field with the whole suite green.
    assert.equal(
      typeof policy.recognition_is_not_endorsement,
      "string",
      "the page must state that listing what an asset sent is not a recommendation",
    );
    assert.match(String(policy.recognition_is_not_endorsement), /no official 1F916 token/);
    assert.match(
      String((policy as { standing_rules: string }).standing_rules),
      /does not buy promotion or placement of any asset/,
      "the ban on spending treasury money on promotion is a constitutional line and was unguarded",
    );

    // And the BLOCK the auditor found: a failed read must never render as zero.
    for (const t of rec.tokens.filter((x) => x.live === true)) {
      assert.doesNotMatch(
        String(t.sent),
        /^0\.0+ /,
        "an unread balance must be reported as unread, never as a precise zero in a sentence",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
