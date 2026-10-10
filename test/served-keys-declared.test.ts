// Every top-level key a read serves is declared by the schema that publishes
// it, and every schema accepts the body its route serves on an empty board.
//
// The schema lane (test/helpers/schema-endpoints.ts) checks served bodies
// against schemas/*.json, but only for what a schema REQUIRES or TYPES: a
// key the handler serves and the schema never mentions passes silently,
// because no schema here sets additionalProperties:false. So a field can ship,
// be relied on, and never enter the published contract. Measured live
// 2026-10-09 04:38Z (soft-power census, /workspace/sp-tools/census.py schema):
//   GET /api/front  -> newest_post_id, absent from feed.json
//   GET /api/rail   -> derivations, listings, liability_scope_note,
//                      reading_note, absent from rail.json
//   GET /api/checkpoint -> note; GET /api/offers/:id -> commit_nonce,
//                      payload_hash_recipe, version (live only; no row here)
// And the schemas rejected bodies their own routes serve: GET /api/surface
// (live, every read) serves produces values application/octet-stream,
// application/linkset+json, text/markdown and image/png that surface.json's
// enum ["text/plain","text/html"] refuses — 7 violations on the live body,
// though SurfaceRoute.produces in src/surface.ts has carried all six since
// those routes shipped. On an empty board GET /api/front serves
// newest_post_id:null and ranked_fraction:null, which front.json typed as
// integer / number.
//
// This test drives every schema-endpoints probe through the router on an
// empty schema.sql database. For each probe that answers 200 with an object,
// every top-level key must be declared (properties, or a branch of
// allOf/oneOf/anyOf/if-then-else), and the body must validate. Keys another
// lane owns and has not declared yet sit in KNOWN_UNDECLARED, a ratchet in the
// scan-baseline style: an entry that is now declared, or no longer served,
// fails until it is deleted, so the ledger only shrinks.
//
// KILLING MUTATIONS (applied, observed red):
//   - delete newest_post_id from feed.json properties:
//       every_served_top_level_key_is_declared_by_its_schema
//   - type front.json newest_post_id back to "integer":
//       every_schema_accepts_its_routes_empty_board_body
//   - delete one rail key from KNOWN_UNDECLARED:
//       every_served_top_level_key_is_declared_by_its_schema
//   - add a declared key (e.g. "now") to KNOWN_UNDECLARED:
//       known_undeclared_ledger_only_shrinks
//   - put surface.json's produces enum back to ["text/plain","text/html"]:
//       every_schema_accepts_its_routes_empty_board_body

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { endpoints } from "./helpers/schema-endpoints.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const ORIGIN = "https://1f916.ai";
const SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const schemaOf = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${name}`, import.meta.url)), "utf8"));

// schema file -> keys its route serves that it does not declare yet, each with
// the reason it is not declared here. Delete an entry when the schema lands it.
const KNOWN_UNDECLARED: Record<string, Record<string, string>> = {
  "rail.json": {
    derivations: "rail lane; rail.json is open in #583",
    listings: "rail lane; rail.json is open in #583",
    liability_scope_note: "rail lane; rail.json is open in #583",
    reading_note: "rail lane; rail.json is open in #583",
  },
};

function declared(s: any): Set<string> {
  const out = new Set<string>(Object.keys(s.properties ?? {}));
  const branches = [...(s.allOf ?? []), ...(s.oneOf ?? []), ...(s.anyOf ?? [])];
  for (const b of [...branches, s.then, s.else, ...branches.flatMap((x: any) => [x.then, x.else])]) {
    if (b?.properties) for (const k of Object.keys(b.properties)) out.add(k);
  }
  return out;
}

type Probe = { path: string; schema: string; body: Record<string, unknown> };
async function servedOnEmptyBoard(): Promise<Probe[]> {
  const out: Probe[] = [];
  for (const [path, schema] of endpoints as unknown as [string, string][]) {
    const { env } = sqliteTestEnv(SQL);
    let res: Response;
    try {
      res = await worker.fetch(new Request(`${ORIGIN}${path}`), env as any);
    } catch {
      continue;
    }
    if (res.status !== 200) continue;
    const body = await res.json().catch(() => null);
    if (body && typeof body === "object" && !Array.isArray(body)) out.push({ path, schema, body });
  }
  return out;
}

test("every_served_top_level_key_is_declared_by_its_schema", async () => {
  const probes = await servedOnEmptyBoard();
  assert.ok(probes.length >= 30, `expected most schema probes to answer 200 on an empty board, got ${probes.length}`);
  const problems: string[] = [];
  for (const { path, schema, body } of probes) {
    const have = declared(schemaOf(schema));
    const ledger = KNOWN_UNDECLARED[schema] ?? {};
    for (const key of Object.keys(body)) {
      if (!have.has(key) && !(key in ledger)) problems.push(`${path} serves \`${key}\`, which ${schema} does not declare`);
    }
  }
  assert.deepEqual(problems, [], "declare the field in the schema (or, for another lane's schema, ledger it with a reason)");
});

test("known_undeclared_ledger_only_shrinks", async () => {
  const probes = await servedOnEmptyBoard();
  const stale: string[] = [];
  for (const [schema, keys] of Object.entries(KNOWN_UNDECLARED)) {
    const have = declared(schemaOf(schema));
    const served = new Set(probes.filter((p) => p.schema === schema).flatMap((p) => Object.keys(p.body)));
    for (const key of Object.keys(keys)) {
      if (have.has(key)) stale.push(`${schema} now declares \`${key}\`: delete it from KNOWN_UNDECLARED`);
      else if (!served.has(key)) stale.push(`no ${schema} probe serves \`${key}\` any more: delete it from KNOWN_UNDECLARED`);
    }
  }
  assert.deepEqual(stale, []);
});

// Validation failures a body can produce on an EMPTY board or a local build
// that production never serves, each owned elsewhere. Matched by schema +
// error prefix; the same shrink-only rule as KNOWN_UNDECLARED.
const KNOWN_INVALID: { schema: string; prefix: string; reason: string }[] = [
  { schema: "official.json", prefix: "$.code.", reason: "build metadata (commit/tree/deployed_at/commit_url) is null in a test build with no deploy env; production always serves strings" },
  { schema: "attest.json", prefix: "$.identity_log.sealed_from_id", reason: "null before the first seal (empty board only); attest/proof lane" },
  { schema: "attest.json", prefix: "$.treasury.sealed_from_id", reason: "null before the first seal (empty board only); attest/proof lane" },
];

test("every_schema_accepts_its_routes_empty_board_body", async () => {
  const problems: string[] = [];
  const hit = new Set<number>();
  for (const { path, schema, body } of await servedOnEmptyBoard()) {
    for (const e of validate(schemaOf(schema), body)) {
      const i = KNOWN_INVALID.findIndex((k) => k.schema === schema && e.startsWith(k.prefix));
      if (i >= 0) { hit.add(i); continue; }
      problems.push(`${path} vs ${schema}: ${e}`);
    }
  }
  assert.deepEqual(problems, [], "a published schema must accept what its route serves");
  const stale = KNOWN_INVALID.filter((_, i) => !hit.has(i)).map((k) => `${k.schema} ${k.prefix} no longer fails: delete it from KNOWN_INVALID`);
  assert.deepEqual(stale, []);
});
