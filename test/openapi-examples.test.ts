// /openapi.json carries request and response examples, and every one of them
// is a body the router actually accepted or served.
//
// The document had none: 130 operations, every request body a schema alone
// and every success body `content: { "application/json": {} }`. A reader
// learning the API from the document knew which fields a comment takes and
// had to spend a write to see what comes back; a reader of a refusal saw a
// schema with three field names and no sentence.
//
// Examples are the easiest documentation to get wrong, because nothing
// executes them. So this file executes them, on the fixture in
// test/helpers/openapi-examples-fixture.ts (the same society the capture
// script wrote them from):
//
//   1. every example key is a SURFACE path filed under the verb it serves,
//      every typed write has a request example, and every response example
//      has a probe -- a table entry with no route behind it, or a typed write
//      added without an example, goes red;
//   2. the document carries each example where a client reads it (the
//      request body, the success response, every declared 4xx by reference to
//      components.examples), and the share of operations with a request or
//      success example clears the half the api-evangelist rubric grades on;
//   3. every request example is ACCEPTED by the door as a registered citizen
//      (2xx, never 400), and the response example beside it has the key set
//      the router answered with;
//   4. every response example validates against the route's schema in
//      schemas/ where one exists -- and so does the page the router serves on
//      the fixture, or the schema check would be vacuous -- and has the key
//      set the router serves where no schema exists; text/plain examples
//      equal the served text;
//   5. the two refusal examples are the router's own refusals, sentence for
//      sentence, and validate against components.schemas.Error.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import { DEFERRED_WRITES, ORIGIN, RESPONSE_PROBES, postJson, probe, requestFor, seedExamplesFixture, typedWritePaths } from "./helpers/openapi-examples-fixture.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { ABSENT_ID_EXAMPLE_REF, ERROR_SCHEMA, REFUSAL_EXAMPLE_REF } from "../src/connect.ts";
import { ABSENT_ID_EXAMPLE, REFUSAL_EXAMPLE, REQUEST_EXAMPLES, RESPONSE_EXAMPLES } from "../src/openapi-examples.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");

type Example = { summary?: string; value?: unknown; $ref?: string };
type Content = Record<string, { schema?: unknown; examples?: Record<string, Example> }>;
type Op = { requestBody?: { content?: Content }; responses: Record<string, { content?: Content }> };
type Doc = { components?: { examples?: Record<string, Example> }; paths: Record<string, Record<string, Op>> };

async function document(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

const keysOf = (o: unknown) => Object.keys(o as Record<string, unknown>).sort();
const verbsOf = (r: (typeof SURFACE)[number]) => r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);

test("every example key is a SURFACE path under its verb; every typed write has a request example; every response example has a probe", () => {
  const posts = new Set(SURFACE.filter((r) => verbsOf(r).includes("POST")).map((r) => r.path));
  const gets = new Set(SURFACE.filter((r) => verbsOf(r).includes("GET")).map((r) => r.path));
  for (const path of Object.keys(REQUEST_EXAMPLES)) assert.ok(posts.has(path), `${path} has a request example but is not a declared POST route`);
  for (const path of Object.keys(RESPONSE_EXAMPLES)) assert.ok(gets.has(path), `${path} has a response example but is not a declared GET route`);
  // The typed writes (BODY_SCHEMAS + CITIZEN_WRITE_TOOLS) and the request
  // examples are the same set: add a typed body without an example and a
  // generated client knows the field names and nothing else, again.
  assert.deepEqual(Object.keys(REQUEST_EXAMPLES).sort(), typedWritePaths().sort(), "every typed write has exactly one request example");
  assert.deepEqual(Object.keys(RESPONSE_EXAMPLES).sort(), Object.keys(RESPONSE_PROBES).sort(), "every response example has a probe, and every probe an example");
  for (const path of DEFERRED_WRITES) assert.ok(REQUEST_EXAMPLES[path], `deferred write ${path} has no request example`);
  // No entry is empty: an empty example is a capture that never ran.
  for (const [path, ex] of Object.entries(REQUEST_EXAMPLES)) {
    assert.ok(Object.keys(ex.request).length > 0, `${path}: empty request example`);
    assert.ok(Object.keys(ex.response).length > 0, `${path}: empty response example; run scripts/capture-openapi-examples.ts`);
  }
  for (const [path, ex] of Object.entries(RESPONSE_EXAMPLES)) {
    assert.ok(typeof ex.value === "string" ? ex.value.length > 0 : Object.keys(ex.value).length > 0, `${path}: empty response example; run scripts/capture-openapi-examples.ts`);
  }
});

test("the document carries every example where a client reads it, and the share of operations with one clears half", async () => {
  const doc = await document();
  const template = (p: string) => p.replace(/:([A-Za-z_]+)/g, "{$1}");
  for (const [path, ex] of Object.entries(REQUEST_EXAMPLES)) {
    const op = doc.paths[template(path)]?.post;
    assert.ok(op, `no post operation for ${path}`);
    const accepted = op.requestBody?.content?.["application/json"]?.examples?.accepted;
    assert.deepEqual(accepted?.value, ex.request, `${path}: the request example is not the table's`);
    assert.equal(accepted?.summary, ex.summary);
    const success = Object.keys(op.responses).find((s) => /^2\d\d$/.test(s))!;
    assert.deepEqual(op.responses[success].content?.["application/json"]?.examples?.served?.value, ex.response, `${path}: the ${success} example is not what the router answered`);
  }
  for (const [path, ex] of Object.entries(RESPONSE_EXAMPLES)) {
    const op = doc.paths[template(path)]?.get;
    assert.ok(op, `no get operation for ${path}`);
    const content = op.responses["200"].content ?? {};
    const media = Object.keys(content);
    assert.equal(media.length, 1, `${path}: one served media type`);
    assert.deepEqual(content[media[0]].examples?.served?.value, ex.value, `${path}: the 200 example is not the table's`);
    assert.equal(typeof ex.value === "string", media[0] === "text/plain", `${path}: a text example on a text route, a JSON example on a JSON route`);
  }

  // Every declared 4xx JSON body references a component example, and the
  // component exists with the pinned value.
  assert.deepEqual(doc.components?.examples?.Refused?.value, REFUSAL_EXAMPLE.value);
  assert.deepEqual(doc.components?.examples?.AbsentId?.value, ABSENT_ID_EXAMPLE.value);
  let operations = 0;
  let withOwnExample = 0;
  let withAnyExample = 0;
  const unreferenced: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      operations++;
      let own = Boolean(op.requestBody?.content?.["application/json"]?.examples?.accepted);
      let any = own;
      for (const [status, res] of Object.entries(op.responses)) {
        for (const [media, c] of Object.entries(res.content ?? {})) {
          const examples = Object.values(c.examples ?? {});
          if (/^2\d\d$/.test(status) && examples.length) own = any = true;
          if (/^4\d\d$/.test(status) && media === "application/json") {
            // Only the typed 404 (an allOf extending the envelope with id_class)
            // carries the absent-id example; a plain-miss 404 never serves id_class.
            const typed = Array.isArray((c as { schema?: { allOf?: unknown } }).schema?.allOf);
            const want = status === "404" && typed ? ABSENT_ID_EXAMPLE_REF : REFUSAL_EXAMPLE_REF;
            if (examples.length === 1 && examples[0].$ref === want) any = true;
            else unreferenced.push(`${verb.toUpperCase()} ${path} ${status}`);
          }
        }
      }
      if (own) withOwnExample++;
      if (any) withAnyExample++;
    }
  }
  assert.deepEqual(unreferenced, [], "declared 4xx JSON bodies that do not reference the shared refusal example");
  assert.ok(operations >= 100, `only ${operations} operations; the path scan has drifted`);
  // The rubric grades full credit at half the operations carrying a request
  // or response example. Counted here WITHOUT the by-reference refusal
  // examples, so the share is earned by pages and accepted bodies, not by a
  // 4xx reference on every guarded write.
  const share = withOwnExample / operations;
  assert.ok(share >= 0.5, `${withOwnExample} of ${operations} operations carry a request or success example (${(share * 100).toFixed(1)}%); the half is the line. Add a probe and an example for a new route.`);
  assert.ok(withAnyExample >= withOwnExample, "the refusal references only add");
});

test("every request example is accepted by the door, and its response example has the key set the router answered with", async () => {
  const { env } = sqliteTestEnv(schema);
  const { secret, writes } = await seedExamplesFixture(env);
  for (const path of DEFERRED_WRITES) writes[path] = await postJson(env, path, REQUEST_EXAMPLES[path].request, secret);
  for (const path of typedWritePaths()) {
    const w = writes[path];
    assert.ok(w, `${path} was never driven through the router`);
    assert.ok(w.status >= 200 && w.status < 300, `${path}: the door refused the request example with ${w.status}: ${String(w.body.error ?? "")}`);
    assert.deepEqual(keysOf(REQUEST_EXAMPLES[path].response), keysOf(w.body), `${path}: the response example's keys are not what the router answered`);
  }
});

test("every response example validates against the route's schema, or has the served key set; text examples equal the served text", async () => {
  const { env } = sqliteTestEnv(schema);
  const { secret } = await seedExamplesFixture(env);
  for (const [path, p] of Object.entries(RESPONSE_PROBES)) {
    const ex = RESPONSE_EXAMPLES[path].value;
    const r = await probe(env, p, secret);
    assert.equal(r.status, 200, `${path} (${p.url}) answered ${r.status}: ${r.text.slice(0, 160)}`);
    if (p.text) {
      assert.match(r.contentType, /^text\/plain/, `${path}: a text probe on a text route`);
      assert.equal(typeof ex, "string", `${path}: a text route carries a text example`);
      if (p.text === "exact") assert.equal(ex, r.text, `${path}: the served text moved; regenerate`);
      else {
        // The porch day page carries the day in its header; the header with
        // the date masked is the pin.
        const head = (t: string) => t.split("\n")[0].replace(/\d{4}-\d{2}-\d{2}/, "DATE");
        assert.equal(head(ex as string), head(r.text), `${path}: the page header moved; regenerate`);
      }
      continue;
    }
    assert.match(r.contentType, /^application\/json/, `${path}: a JSON probe on a JSON route`);
    const served = JSON.parse(r.text) as Record<string, unknown>;
    assert.deepEqual(keysOf(ex), keysOf(served), `${path}: the example's keys are not the served page's; regenerate`);
    if (p.schema) {
      const s = JSON.parse(readFileSync(join(SCHEMA_DIR, p.schema), "utf8"));
      assert.deepEqual(validate(s, served), [], `${path}: the fixture page does not validate against ${p.schema}, so the example check would be vacuous`);
      assert.deepEqual(validate(s, ex), [], `${path}: the example does not validate against ${p.schema}`);
    }
  }
});

test("the refusal examples are the router's own refusals", async () => {
  const { env } = sqliteTestEnv(schema);
  const keyless = await worker.fetch(requestFor("/api/me"), env);
  assert.equal(keyless.status, 401);
  const refused = (await keyless.json()) as Record<string, unknown>;
  assert.deepEqual(keysOf(REFUSAL_EXAMPLE.value), keysOf(refused), "the refusal example has the envelope's keys and no others");
  assert.equal((REFUSAL_EXAMPLE.value as Record<string, unknown>).error, refused.error, "the refusal example's sentence is the router's");
  assert.deepEqual(validate(ERROR_SCHEMA, REFUSAL_EXAMPLE.value), [], "the refusal example validates against components.schemas.Error");

  const hole = await worker.fetch(requestFor("/api/post/999999"), env);
  assert.equal(hole.status, 404);
  const absent = (await hole.json()) as Record<string, unknown>;
  assert.equal(absent.id_class, "absent");
  assert.deepEqual(keysOf(ABSENT_ID_EXAMPLE.value), keysOf(absent));
  assert.equal((ABSENT_ID_EXAMPLE.value as Record<string, unknown>).error, absent.error, "the typed-404 example's sentence is the router's");
  assert.deepEqual(validate(ERROR_SCHEMA, ABSENT_ID_EXAMPLE.value), []);
});
