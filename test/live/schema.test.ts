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
const endpoints = [
  ["/api/attest", "attest.json"],
  // The schemas require the new fields now. Live production cannot satisfy
  // them until this branch deploys, so the marker stages only the live probe;
  // local behavior tests require the fields before merge.
  // Marker on a ROW field, not a top-level one: the newest thing these schemas
  // require is per-post (#163's body_length), and a marker naming an older
  // top-level field would let the probe pass against a deployment that predates
  // the contract it is checking.
  ["/api/front", "feed.json", "posts.0.body_length"],
  ["/api/new", "new-feed.json", "posts.0.body_length"],
  // Marker is a path: citizen_id lives on each row, not at the top level.
  ["/api/citizens", "citizens.json", "citizens.0.citizen_id"],
  ["/api/events", "events.json"],
  // The shape no probe ever sent. counts_state has been able to return
  // "no_such_citizen" since the citizen filter shipped, and events.json did not
  // list it in the enum until this branch, so every ?citizen=<unknown> response
  // production served was a violation of its own published contract — and the
  // suite was green the whole time, because the only /api/events probe sent no
  // query string at all and can therefore only ever see complete or short.
  // A contract is only checked on the shapes somebody asks for.
  // The handle is deliberately one nobody would register, and it must stay
  // inside the accepted class [A-Za-z0-9_-]{2,32}: the first version of this
  // probe was 36 characters, drew a 400, and SKIPPED as "API unreachable".
  // That is why fetchJson now refuses to let a 400 look like a skip.
  ["/api/events?citizen=no-such-citizen-probe", "events.json"],
  // The busiest read route on the board and the only one every citizen sweep
  // depends on, with no contract until now. Two probes because the two cursor
  // contracts are DIFFERENT response bodies: legacy mode leaves both per-stream
  // tokens and both hidden_by_since counts null, and only the ID-mode probe
  // exercises the snap:/id: token grammar and the non-null snapshot counters.
  // Marker is page_saturated, which shipped with #132.
  // Marker moved from page_saturated to rows_returned with #155: the marker
  // has to name the NEWEST field the schema requires, or the probe passes on a
  // deployment that predates the contract it is checking.
  ["/api/changes?since=0", "changes.json", "rows_returned"],
  ["/api/changes?since=0&posts_since=init&comments_since=init", "changes.json", "rows_returned"],
  // payouts.json has existed since the payment rail landed and no probe ever
  // read it against the deployment. A contract nothing checks is prose.
  ["/api/payouts", "payouts.json"],
  // The paged branch is a DIFFERENT response body from the default DESC one:
  // it alone carries order, next_since, latest_event_id and
  // since_is_past_the_end. The list probed only the default view, so every
  // claim the schema makes about the paged branch was unchecked against a
  // deployment. since_is_past_the_end is the marker, so this stages until the
  // branch that adds it is live and then validates on every run.
  // events-paged.json, not events.json: the ASC branch is a different body and
  // events.json has to leave its four fields optional for the default DESC view,
  // so this probe validated against a contract that would have accepted a
  // response with all four missing. Found 2026-08-26 by the marker guard below.
  ["/api/events?since=0", "events-paged.json", "since_is_past_the_end"],
  // content_hash_recipe is the marker: the schema now requires the anchor block
  // and the deployment does not carry it until this lands and ships.
  ["/api/docket", "docket.json", "content_hash_recipe"],
  ["/api/post/475", "post.json"],
  // Skips until this branch is deployed (fetchJson throws on the 404), then
  // validates on every run like the rest.
  ["/api/provenance", "provenance.json", "comparison"],
];

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

test("every deployment marker is a field its schema actually requires", () => {
  // A marker is the switch that decides whether a live probe runs at all, so a
  // marker naming a field the schema does not require is a probe that can stage
  // itself off forever, or one that runs against a deployment older than the
  // contract. Both read as green. This checks the half that is checkable: the
  // marker is a required top-level property of the schema it gates.
  //
  // KILLING MUTATION: point any marker at a field not in the schema's
  // `required` list -> red.
  for (const [path, schemaFile, deploymentMarker] of endpoints) {
    if (!deploymentMarker || deploymentMarker.includes(".")) continue;
    const schema = loadSchema(schemaFile);
    // Required, not merely declared. A marker the schema does not require is a
    // switch that can turn a probe off against a contract nothing enforces,
    // which is how /api/events?since=0 came to validate against a schema that
    // would have accepted a response missing every field the probe was added
    // for.
    assert.ok(
      Array.isArray(schema.required) && schema.required.includes(deploymentMarker),
      `${path}: marker "${deploymentMarker}" is not a required property of ${schemaFile}`,
    );
  }
});
