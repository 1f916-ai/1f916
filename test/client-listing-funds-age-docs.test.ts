import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Listing funding-snapshot age[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("listing client docs explain the one-time funding-snapshot age contract", () => {
  assert.ok(section, "listing funding-snapshot documentation section exists");
  for (const detail of [
    "GET /api/listings",
    "GET /api/listings/{id}",
    "`funds_age_ms`",
    "`funds_checked_at`",
    "`funds_seen_atomic`",
    "`funds_block_number`",
    "`funds_checked_at_note`",
    "`payload_hash`",
    "empty",
  ]) {
    assert.ok(section.includes(detail), `docs explain ${detail}`);
  }
  assert.ok(section.includes("`GET /api/listings/{id}` detail carries `funds_seen_atomic`, `funds_checked_at`, `funds_block_number`, and `funds_age_ms`"));
  // The collection now carries the snapshot age (funds_checked_at + funds_age_ms)
  // per row, so staleness is comparable across listings without a detail fetch;
  // only funds_block_number stays detail-only (larry-synctzn c147329/c147330).
  assert.ok(section.includes("`GET /api/listings` collection carries `funder_address`, `funds_seen_atomic`, `funds_checked_at`, and `funds_age_ms` on each row"));
  assert.match(section, /`funds_block_number` is detail-only/);
  assert.doesNotMatch(section, /collection carries only `funder_address` and `funds_seen_atomic`/);
  // On the collection the age note is a response-level field, not per row.
  assert.match(section, /`funds_checked_at_note` appears on the `GET \/api\/listings` response when any row has a snapshot/);
  assert.match(section, /`funds_age_ms` is calculated from a handler timestamp sampled before the handler completes its database reads/);
  assert.match(section, /response-level `now`\/`now_utc` wrapper clock is stamped after the handler returns/);
  assert.match(section, /may be lower than `now - funds_checked_at` by request-processing time/);
  assert.match(section, /Use the returned `funds_age_ms` as the server-calculated age/);
  assert.match(section, /allow for that drift rather than requiring exact equality/);
  assert.doesNotMatch(section, /calculate age as `now - funds_checked_at`/);
  assert.doesNotMatch(section, /funds_age_ms` is that age in milliseconds/);
  assert.match(section, /funds_age_ms` is null when no funds snapshot exists/i);
  assert.match(section, /not evidence that the balance is still there/i);
  assert.doesNotMatch(section, /without a separate field/i);
});
