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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIVE_PROBES, LIVE_SKIP_REASON, ProbeRefused, RateLimited, liveFetch } from "../helpers/live.ts";
import { validate } from "../helpers/json-schema.ts";
import { endpoints } from "../helpers/schema-endpoints.ts";

const BASE = "https://1f916.ai";
const SCHEMA_DIR = join(import.meta.dirname, "..", "..", "schemas");

// Minimal JSON Schema validator: draft 2020-12 subset covering the keywords
// used in these schemas. Full Ajv is a dependency this repo deliberately
// does not have; the subset is enough to catch the contract breaks that
// matter (wrong types, missing fields, bad enums, malformed hashes).

function loadSchema(name) {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

async function fetchJson(path) {
  const r = await liveFetch(BASE + path, { headers: { "User-Agent": "1f916-schema-validator/1.0" } });
  if (r.status === 400) {
    throw new ProbeRefused(
      `${path} -> 400. The deployment answered and refused this request, so the PROBE PATH is wrong. ` +
        `This is not unreachability and must not skip: ${(await r.text()).slice(0, 300)}`,
    );
  }
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

// Every schema file must be well-formed JSON and carry the draft marker.
// Live contract checks. Skipped when the API is unreachable.

for (const [path, schemaFile, deploymentMarker] of endpoints) {
  test(`live: ${path} conforms to ${schemaFile}`, async (t) => {
    if (!LIVE_PROBES) {
      t.skip(LIVE_SKIP_REASON);
      return;
    }
    let data;
    try {
      data = await fetchJson(path);
    } catch (e) {
      // A rate limit is NOT a skip. #151: a fully rate-limited run used to
      // report `fail 0` with every probe silently skipped, so "checked" and
      // "could not check" produced the same summary line.
      if (e instanceof RateLimited || e instanceof ProbeRefused) throw e;
      // #151 remaining: unreachable and undeployed used to skip green under
      // LIVE_PROBES=1. The live lane is supposed to fail closed.
      throw new Error(`API unreachable: ${e instanceof Error ? e.message : e}`);
    }
    const markerPresent = (marker) => marker.split(".").reduce((o, k) => (o != null && typeof o === "object" ? o[k] : undefined), data) !== undefined;
    if (deploymentMarker && !markerPresent(deploymentMarker)) {
      throw new Error(`new contract not deployed yet: missing ${deploymentMarker}`);
    }
    const schema = loadSchema(schemaFile);
    const errors = validate(schema, data);
    assert.deepEqual(errors, [], `schema violations for ${path}:\n${errors.join("\n")}`);
  });
}
