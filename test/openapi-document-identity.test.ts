// /openapi.json carries its own identity, so a token/example census of it can
// be dated and compared across reads, sessions and deploys (no-scheduler,
// c104659 on post 8427; WQ-344). Before this, the only document-level fields
// were x-now / x-now_utc, which move every request, so two readers (and the
// same reader twice) could not tell whether they counted the same document or
// name which deploy's regenerated fixture they measured. Two fields fix that:
//
//   x-examples-generated-at — when the response-example corpus was captured.
//   x-document-sha256       — the content hash, clock removed, so it is stable
//                             across reads of one deploy and a reader comparing
//                             two reads needs only to compare this string.
//
// What each test would miss if its guarantee were deleted is named on it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { openApi, openApiDocumentSha256, canonicalJson } from "../src/connect.ts";
import { EXAMPLES_GENERATED_AT } from "../src/openapi-examples.ts";
import { CAPTURED } from "../src/openapi-examples-captured.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

/** The newest `now` the captured corpus carries, computed independently of the
 *  source so the test pins the MEANING of x-examples-generated-at, not just
 *  that some ISO string is present. */
function newestCapturedNowISO(): string {
  let max = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return void v.forEach(walk);
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) {
      if (k === "now" && typeof val === "number" && val > max) max = val;
      else walk(val);
    }
  };
  walk(CAPTURED);
  return new Date(max).toISOString();
}

test("the served /openapi.json carries both identity fields, and the hash is the content, not the clock (WQ-344)", async () => {
  const { env } = sqliteTestEnv(schema);
  const read = async () => (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Record<string, unknown>;
  const doc = await read();

  // x-examples-generated-at is the capture instant, equal to the newest clock
  // the examples carry (what a reader would compute scanning the document).
  // Missing field -> this reds; a wrong value (e.g. the min) -> this reds.
  assert.equal(doc["x-examples-generated-at"], newestCapturedNowISO(), "x-examples-generated-at is the newest captured `now`");
  assert.equal(doc["x-examples-generated-at"], EXAMPLES_GENERATED_AT, "and equals the exported constant the server used");
  assert.match(String(doc["x-examples-generated-at"]), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, "served as an ISO instant");

  // x-document-sha256 is 64 hex and reproduces when a reader reruns the recipe
  // over the served document. Drop the field at the serve site -> undefined,
  // this reds.
  const served = String(doc["x-document-sha256"]);
  assert.match(served, /^[0-9a-f]{64}$/, "x-document-sha256 is a sha256 hex digest");
  assert.equal(served, await openApiDocumentSha256(doc), "a reader rerunning the recipe over the served document reproduces the hash");
});

test("x-document-sha256 names the content and not the request clock: it is stable when only the clock moves (WQ-344)", async () => {
  // The whole point of the field. openApi() stamps x-now/x-now_utc from the
  // instant it is built; the hash recipe removes exactly those, so two builds a
  // day apart hash identically. KILLING MUTATION: remove "x-now" (or "x-now_utc")
  // from DOCUMENT_IDENTITY_OMIT in connect.ts and these two assertions red,
  // because the moving clock would then be inside the hashed bytes.
  const early = openApi(ORIGIN, 1_000) as Record<string, unknown>;
  const late = openApi(ORIGIN, 1_000 + 86_400_000) as Record<string, unknown>;
  assert.notEqual(early["x-now"], late["x-now"], "precondition: the two builds carry different clocks");
  assert.equal(await openApiDocumentSha256(early), await openApiDocumentSha256(late), "the content hash does not move with the clock");

  // And it is self-excluding: adding the field back in does not change the hash,
  // so the served document hashes to the value it carries.
  const withField = { ...early, "x-document-sha256": "deadbeef" };
  assert.equal(await openApiDocumentSha256(withField), await openApiDocumentSha256(early), "x-document-sha256 is excluded from its own hash");
});

test("canonicalJson sorts keys at every depth and drops whitespace, so the hash is order-independent", async () => {
  // The recipe must be reproducible regardless of how a reader's JSON library
  // orders keys; canonicalJson sorts at every depth. If it stopped sorting, two
  // key orders of the same content would hash differently and the "compare two
  // reads" promise would break.
  const a = { b: 1, a: { d: [3, 2], c: 4 } };
  const b = { a: { c: 4, d: [3, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b), "key order does not change the canonical form");
  assert.equal(canonicalJson(a), '{"a":{"c":4,"d":[3,2]},"b":1}', "sorted keys, array order kept, no whitespace");
});

test("x-document-sha256-spec names the EXACT ECMAScript canonicalization, and canonicalJson obeys it (WQ-346)", async () => {
  // fieldwork-1010 (c105022 on post 8427): the hash is stable, but the recipe
  // was described as "the same shape as Python json.dumps", which is false for
  // astral-plane keys and float formatting. The served spec now names the exact
  // ECMAScript semantics. These assertions pin the spec to the code so it cannot
  // drift into a decorative lie.
  // KILLING MUTATION: drop the x-document-sha256-spec field in openApi() -> the
  // presence assertion reds; change canonicalJson to escape non-ASCII or sort by
  // code point -> the behaviour assertions red.
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Record<string, unknown>;
  const spec = doc["x-document-sha256-spec"] as Record<string, unknown>;
  assert.ok(spec, "the served document carries x-document-sha256-spec");
  assert.deepEqual(spec.omit, ["x-now", "x-now_utc", "x-document-sha256"], "the spec names exactly the three omitted root keys");
  assert.match(String(spec.key_order), /UTF-16/, "the spec says keys sort by UTF-16 code unit");
  assert.match(String(spec.not_python), /NOT json\.dumps/, "the spec warns it is not the Python one-liner");

  // The spec is true of the code: ECMAScript number-to-string, not Python's.
  assert.equal(canonicalJson({ a: 1.0 }), '{"a":1}', "an integral float serializes as 1, not 1.0 (ECMAScript)");
  assert.equal(canonicalJson({ a: 1e-7 }), '{"a":1e-7}', "1e-7 serializes as 1e-7, not 1e-07 (ECMAScript)");
  // Keys sort by UTF-16 code unit: U+10000 (a surrogate pair starting 0xD800)
  // sorts BEFORE U+E000, the opposite of Unicode code-point order.
  assert.equal(
    canonicalJson({ ["\u{10000}"]: 2, [""]: 1 }),
    '{"\u{10000}":2,"":1}',
    "astral-plane key U+10000 sorts before U+E000 by UTF-16 code unit",
  );

  // The reporter's whole fixture hashes to the ECMAScript digest, not the Python
  // one — pinned so the divergence the spec documents stays a measured fact.
  const fixture = { unicode_keys: { [""]: 1, ["\u{10000}"]: 2 }, integral_float: 1.0, small_float: 1e-7 };
  assert.equal(
    await openApiDocumentSha256(fixture),
    "97f0b64aa95e09d281a9a90a80c46fdeac92b2b1813d2327d73acbec868eac32",
    "the ECMAScript canonicalization of fieldwork-1010's fixture; the Python one-liner gives c9cfed52..., a different hash",
  );
});

test("the spec names the small-decimal band and the rule is reproduce-exactly, not a finite list (WQ-348)", async () => {
  // parappa (c105308 on post 8427): the spec named three divergences but not a
  // fourth live-bytes-visible one — for 1e-6 <= |x| < 1e-4 ECMAScript writes a
  // plain decimal (0.00001 -> "0.00001") while Python writes an exponent
  // ("1e-05"). The spec now names this band AND reframes the list as illustrative
  // of a rule (reproduce ECMAScript Number::toString exactly), so the next edge
  // case is already covered by the rule rather than needing another append.
  // KILLING MUTATION: drop the 0.00001/1e-05 clause from not_python -> the band
  // assertion reds; a canonicalJson that stopped using JSON.stringify for numbers
  // -> the decimal assertion reds.
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Record<string, unknown>;
  const spec = doc["x-document-sha256-spec"] as Record<string, unknown>;
  assert.match(String(spec.not_python), /0\.00001.*1e-05/, "the spec names the 1e-6..1e-4 decimal-vs-exponent band");
  assert.match(String(spec.not_python), /reproduce ECMAScript Number::toString and UTF-16 key order EXACTLY, not tick off a finite list/, "and states the rule is reproduce-exactly, not an enumerated list");
  assert.match(String(spec.serialization), /Number::toString/, "serialization cites the authoritative ECMA-262 algorithm");

  // The code is what the spec describes: a value in the band is a plain decimal.
  assert.equal(canonicalJson({ a: 1e-5 }), '{"a":0.00001}', "1e-5 serializes as the decimal 0.00001 (ECMAScript), not Python's 1e-05");
  assert.equal(canonicalJson({ a: 1e-6 }), '{"a":0.000001}', "1e-6 is still a decimal in ECMAScript");
  assert.equal(canonicalJson({ a: 1e-7 }), '{"a":1e-7}', "1e-7 is the first exponent form, matching the named boundary");
});
