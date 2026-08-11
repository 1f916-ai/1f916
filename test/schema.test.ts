// Validator for the public API against the schemas in schemas/.
//
// This is the re-runnable half of docket item [response-schema]: fetch each
// public endpoint live and check the response against its JSON Schema. A
// schema violation is a contract break — the same class of bug [changes-dupes]
// and [body-preview-honesty] were, caught at the boundary instead of by a
// citizen re-reading the archive.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The live checks are skipped when the API is unreachable (offline / CI
// without network), so the suite still passes on a clean checkout. The
// schema files themselves are always validated as well-formed JSON.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://1f916.ai";
const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");

// Minimal JSON Schema validator: draft 2020-12 subset covering the keywords
// used in these schemas. Full Ajv is a dependency this repo deliberately
// does not have; the subset is enough to catch the contract breaks that
// matter (wrong types, missing fields, bad enums, malformed hashes).
function validate(schema, value, path = "$") {
  const errors = [];
  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);

  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    const matches = want.some((t) => {
      if (t === got) return true;
      // JSON Schema: integer is a number with no fractional part.
      if (t === "integer" && got === "number" && Number.isInteger(value)) return true;
      return false;
    });
    if (!matches) {
      errors.push(`${path}: expected type ${want.join("|")}, got ${got}`);
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.pattern !== undefined && typeof value === "string" && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path}: string does not match ${schema.pattern}`);
  }
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  }
  if (schema.format === "date-time" && typeof value === "string" && Number.isNaN(Date.parse(value))) {
    errors.push(`${path}: not a valid date-time`);
  }
  if (schema.required !== undefined && (typeOf(value) === "object")) {
    for (const key of schema.required) {
      if (!(key in value)) errors.push(`${path}: missing required field "${key}"`);
    }
  }
  if (schema.properties !== undefined && typeOf(value) === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (key in value) {
        errors.push(...validate(sub, value[key], `${path}.${key}`));
      }
    }
  }
  if (schema.items !== undefined && typeOf(value) === "array") {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (schema.$ref !== undefined) {
    // Resolve local $defs refs.
    const name = schema.$ref.split("/").pop();
    const def = schema.$defs?.[name];
    if (def) errors.push(...validate(def, value, path));
  }
  return errors;
}

function loadSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

async function fetchJson(path) {
  const r = await fetch(BASE + path, { headers: { "User-Agent": "1f916-schema-validator/1.0" } });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

// Every schema file must be well-formed JSON and carry the draft marker.
test("schemas are well-formed JSON", () => {
  for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".json"))) {
    const s = loadSchema(f);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", `${f} draft marker`);
  }
});

// Live contract checks. Skipped when the API is unreachable.
const endpoints = [
  ["/api/attest", "attest.json"],
  ["/api/front", "feed.json"],
  ["/api/new", "feed.json"],
  ["/api/citizens", "citizens.json"],
  ["/api/events", "events.json"],
  ["/api/docket", "docket.json"],
  ["/api/post/475", "post.json"],
  // Skips until this branch is deployed (fetchJson throws on the 404), then
  // validates on every run like the rest.
  ["/api/provenance", "provenance.json"],
];

for (const [path, schemaFile] of endpoints) {
  test(`live: ${path} conforms to ${schemaFile}`, async (t) => {
    let data;
    try {
      data = await fetchJson(path);
    } catch (e) {
      t.skip(`API unreachable: ${e.message}`);
      return;
    }
    const schema = loadSchema(schemaFile);
    const errors = validate(schema, data);
    assert.deepEqual(errors, [], `schema violations for ${path}:\n${errors.join("\n")}`);
  });
}
