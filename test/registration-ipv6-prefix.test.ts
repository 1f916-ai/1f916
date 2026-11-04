// SEC-4 (GHSA-3x3m-57c2-ph56, tally-stick). The registration throttle hashed the
// full CF-Connecting-IP. An IPv6 host controls a whole /64 (2^64 addresses), so
// every request from a fresh address in that prefix opened a new, empty bucket
// and the per-address limit never bound — one /64 could mint up to the
// society-wide ceiling. The throttle now counts an IPv6 address against its /64.
//
// KILLING MUTATION: make registrationBucket the identity (return ip). The
// integration test's fourth registration from the same /64 then lands in its own
// bucket and succeeds, and "a /64 shares one per-address bucket" goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { register, registrationBucket, REGISTRATION_THROTTLE, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
  CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, alg TEXT, public_key TEXT, thumbprint TEXT UNIQUE, custody TEXT, status TEXT, bound_at INTEGER);
  CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE);
  CREATE TABLE reg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT, created_at INTEGER);
`;

test("an IPv4 address is one host and is bucketed unchanged", () => {
  assert.equal(registrationBucket("203.0.113.7"), "203.0.113.7");
});

test("two IPv6 addresses in the same /64 share one bucket, two in different /64s do not", () => {
  const a = registrationBucket("2001:db8:1:2::1");
  const b = registrationBucket("2001:db8:1:2:ffff:ffff:ffff:ffff");
  const c = registrationBucket("2001:db8:1:3::1");
  assert.equal(a, b, "same /64 -> same bucket");
  assert.notEqual(a, c, "a different /64 is a different bucket");
  assert.match(a, /\/64$/, "the bucket is marked as a prefix, not a literal address");
});

test("equivalent IPv6 spellings collapse to the same bucket", () => {
  // Leading zeros, case, and :: compression are all the same /64.
  const forms = ["2001:0DB8:0000:0001::1", "2001:db8:0:1::2", "2001:db8:0:1:3:4:5:6"];
  const buckets = new Set(forms.map(registrationBucket));
  assert.equal(buckets.size, 1, `all forms are one /64, got ${[...buckets].join(" | ")}`);
});

test("a string that is not a parseable IPv6 literal is returned unchanged, never a weaker shared bucket", () => {
  assert.equal(registrationBucket("2001:db8::oops::1"), "2001:db8::oops::1"); // two "::"
  assert.equal(registrationBucket("not-an-ip"), "not-an-ip");
});

test("a /64 shares one per-address registration bucket: the fourth registration from the prefix is throttled", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  // Three distinct addresses, all inside 2001:db8:1:2::/64.
  const addrs = ["2001:db8:1:2::1", "2001:db8:1:2::2", "2001:db8:1:2::3"];
  for (let i = 0; i < REGISTRATION_THROTTLE.per_address_per_hour; i++) {
    await register(env, `v6-${i}`, "test-model", addrs[i]);
  }
  // A fourth, different address in the SAME /64 must now be refused per-address.
  await assert.rejects(
    () => register(env, "v6-over", "test-model", "2001:db8:1:2::dead"),
    (err: unknown) => {
      assert.ok(err instanceof SocietyError && err.status === 429, "the fourth from the /64 is a 429");
      assert.match(err.message, new RegExp(`${REGISTRATION_THROTTLE.per_address_per_hour} per address per hour`));
      return true;
    },
  );
  // A different /64 still gets its own allowance (the bucket is the prefix, not all of IPv6).
  await register(env, "other-64", "test-model", "2001:db8:1:9::1");
});
