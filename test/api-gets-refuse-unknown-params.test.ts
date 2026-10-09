// Every GET under /api/ refuses a query parameter it does not read.
//
// After the keyless reads were closed (#550 #551 #553 #555 #556), the census
// still found ten single-record reads that answered 200 to any query string:
// /api/mandates/1?verbose=1, /api/listings/13?zzz=1 and the rest came back as
// if the parameter had shaped the record. A client that typo'd a filter, or
// carried one over from the list route, read an untouched record as the
// filtered answer. checkQueryParams already refuses by name; those routes just
// never called it, and nothing made them.
//
// So this file holds the class, not the ten instances: the set of /api/ GETs
// on the published surface must equal the set with a QUERY_PARAMS entry. That
// closes the loop with openapi-400-query-params.test.ts, which already drives
// the live router with an unknown key on every route the table lists, so a
// route that is tabled but never calls the guard fails there. Here, too,
// each formerly silent route must answer 400 naming the key — with a baseline
// proving the same URL without the key is NOT a 400, so the refusal is
// attributable to the parameter and not to the id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

function apiGets(): string[] {
  const out: string[] = [];
  for (const r of SURFACE) {
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    if (verbs.includes("GET") && r.path.startsWith("/api/")) out.push(r.path);
  }
  return out;
}

test("every GET under /api/ on the surface has a QUERY_PARAMS entry", () => {
  const gets = apiGets();
  assert.ok(gets.length >= 60, `only ${gets.length} /api/ GETs on the surface; the mapping has drifted`);
  const unguarded = gets.filter((p) => !QUERY_PARAMS[p]);
  assert.deepEqual(unguarded, [], `these /api/ GETs accept any query string: ${unguarded.join(", ")}`);
});

// The ten that were silent, with a concrete path for each. Ids that do not
// exist are fine: the guard runs before the lookup, and the baseline below
// shows what the lookup alone answers.
const FORMERLY_SILENT: ReadonlyArray<[route: string, path: string]> = [
  ["/api/mandates/:id", "/api/mandates/1"],
  ["/api/mandates/:id/envelope", "/api/mandates/1/envelope"],
  ["/api/anchors/:id.ots", "/api/anchors/1.ots"],
  ["/api/anchors/:id.txt", "/api/anchors/1.txt"],
  ["/api/memory/:id/file", "/api/memory/1/file"],
  ["/api/attestations/:id", "/api/attestations/1"],
  ["/api/offers/:id", "/api/offers/1"],
  ["/api/listings/:id", "/api/listings/1"],
  ["/api/payout-bindings/:id", "/api/payout-bindings/1"],
  ["/api/keys/:handle", "/api/keys/nobody-here"],
];

// /api/memory/:id/file is a bearer read, and on bearer reads authenticate()
// runs before checkQueryParams (openapi-400-query-params.test.ts pins that on
// /api/me), so its refusal is asserted with a credential.
const SECRET = "test-secret-api-gets-refuse";

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("each formerly silent id read refuses an unknown key by name, and only because of the key", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'reader', 'test-model', ?, 0, 0)").run(await sha256Hex(SECRET));
  const init = { headers: { authorization: `Bearer ${SECRET}` } };
  for (const [route, path] of FORMERLY_SILENT) {
    assert.ok(QUERY_PARAMS[route], `${route} must be on the table`);
    const base = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
    assert.notEqual(base.status, 400, `${path} baseline is already 400; the mutant below would be vacuous`);
    const res = await worker.fetch(new Request(`${ORIGIN}${path}?zzz_typo=1`, init), env);
    assert.equal(res.status, 400, `${path}?zzz_typo=1 answered ${res.status}, not a refusal`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /zzz_typo/, `${path}: the refusal must name the key`);
    assert.match(body.error ?? "", new RegExp(route.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), `${path}: the refusal must name the route`);
  }
});
