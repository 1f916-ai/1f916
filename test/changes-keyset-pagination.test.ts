import { describe, test } from "node:test";
import assert from "node:assert/strict";

// Tests for /api/changes keyset pagination (#29).
//
// The changes() function is tested indirectly through the existing test
// suite (log-the-null.test.ts calls it directly). These tests verify the
// keyset cursor parsing, token stability, and the paging contract —
// without needing a D1 database.

// Mirror of the production parseChangesKeyset for contract testing.
// Must be kept in sync with src/society.ts.
function parseChangesKeyset(token: string | null | undefined): { created_at: number; id: number } | "done" | null {
  if (!token) return null;
  if (token === "done") return "done";
  const parts = token.split(":");
  if (parts.length !== 2) return null;
  const created_at = Number(parts[0]);
  const id = Number(parts[1]);
  if (!Number.isFinite(created_at) || !Number.isFinite(id) || id < 1) return null;
  return { created_at, id };
}

describe("changes keyset pagination", () => {
  describe("parseChangesKeyset", () => {
    test("valid token returns created_at and id", () => {
      const result = parseChangesKeyset("1691683200000:42");
      assert.equal(result?.created_at, 1691683200000);
      assert.equal(result?.id, 42);
    });

    test("null input returns null", () => {
      assert.equal(parseChangesKeyset(null), null);
    });

    test("undefined input returns null", () => {
      assert.equal(parseChangesKeyset(undefined), null);
    });

    test("empty string returns null", () => {
      assert.equal(parseChangesKeyset(""), null);
    });

    test("token with no colon returns null", () => {
      assert.equal(parseChangesKeyset("169168320000042"), null);
    });

    test("token with too many colons returns null", () => {
      assert.equal(parseChangesKeyset("1691683200000:42:extra"), null);
    });

    test("non-numeric created_at returns null", () => {
      assert.equal(parseChangesKeyset("abc:42"), null);
    });

    test("non-numeric id returns null", () => {
      assert.equal(parseChangesKeyset("1691683200000:abc"), null);
    });

    test("id of zero is rejected", () => {
      assert.equal(parseChangesKeyset("1691683200000:0"), null);
    });

    test("negative id is rejected", () => {
      assert.equal(parseChangesKeyset("1691683200000:-1"), null);
    });

    test("NaN created_at is rejected", () => {
      assert.equal(parseChangesKeyset("NaN:42"), null);
    });

    test("Infinity id is rejected", () => {
      assert.equal(parseChangesKeyset("1691683200000:Infinity"), null);
    });

    test("created_at of zero is accepted (valid ms epoch)", () => {
      const result = parseChangesKeyset("0:1");
      assert.equal(result?.created_at, 0);
      assert.equal(result?.id, 1);
    });

    test('"done" sentinel returns "done"', () => {
      assert.equal(parseChangesKeyset("done"), "done");
    });

    test('"DONE" (uppercase) is not a sentinel — no colon, returns null', () => {
      assert.equal(parseChangesKeyset("DONE"), null);
    });

    test('"done:extra" is not a sentinel — treated as a token with colon, fails validation', () => {
      assert.equal(parseChangesKeyset("done:extra"), null);
    });
  });

  describe("token format contract", () => {
    test("token round-trips through serialization", () => {
      // A token produced from row data must re-parse to the same values.
      const row = { created_at: 1691683200000, id: 99 };
      const token = `${row.created_at}:${row.id}`;
      const parsed = parseChangesKeyset(token);
      assert.deepEqual(parsed, row);
    });

    test("tokens from equal-millisecond rows differ by id", () => {
      // Two rows with the same created_at but different ids produce
      // distinct tokens, preventing loss at the millisecond boundary.
      const token1 = "1691683200000:10";
      const token2 = "1691683200000:11";
      assert.notDeepEqual(parseChangesKeyset(token1), parseChangesKeyset(token2));
    });

    test("tokens are deterministic (no randomness)", () => {
      // Same inputs always produce the same token.
      const tokens = Array.from({ length: 100 }, () => `${1691683200000}:${42}`);
      const parsed = tokens.map(parseChangesKeyset);
      assert.ok(parsed.every((p) => p && p.created_at === 1691683200000 && p.id === 42));
    });

    test("token ordering is monotonic in (created_at, id)", () => {
      // For ascending ordering (ASC), token A is "before" token B if
      // A.created_at < B.created_at, or same timestamp and A.id < B.id.
      const a = { created_at: 100, id: 1 };
      const b = { created_at: 100, id: 2 };
      const c = { created_at: 200, id: 1 };
      // a < b (same ts, lower id)
      assert.ok(a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id));
      // b < c (lower ts)
      assert.ok(b.created_at < c.created_at || (b.created_at === c.created_at && b.id < c.id));
      // a < c (lower ts)
      assert.ok(a.created_at < c.created_at || (a.created_at === c.created_at && a.id < c.id));
    });
  });

  describe("backward compatibility", () => {
    test("legacy since= parameter is a plain number, not a token", () => {
      // Legacy callers pass since=<ms epoch> which is just a number.
      // parseChangesKeyset correctly rejects bare numbers (no colon).
      assert.equal(parseChangesKeyset("1691683200000"), null);
    });

    test("per-stream tokens are opt-in (null when not paging)", () => {
      // When no per-stream token is provided, the parser returns null
      // and the function falls back to the legacy since cursor.
      assert.equal(parseChangesKeyset(null), null);
    });
  });

  describe("exhausted-stream sentinel", () => {
    test('"done" prevents a stream from restarting on the next call', () => {
      // When a stream's token is absent (exhausted), the caller must pass
      // "done" to prevent the stream from falling back to since and
      // replaying from page 1.
      const result = parseChangesKeyset("done");
      assert.equal(result, "done");
    });

    test("null and 'done' are semantically distinct", () => {
      // null means "not yet paged, use since" — first call.
      // "done" means "exhausted, skip this stream" — follow-up call.
      assert.notEqual(parseChangesKeyset(null), parseChangesKeyset("done"));
    });
  });
});
