// /apis.json and /.well-known/api-catalog: the two indexes of this origin's
// discovery documents, and the four ways an index can lie.
//
// WHY THEY EXIST. The OpenAPI, the llms.txt, the MCP manifest and the OAuth
// metadata were each served, and nothing served said where they all are. An
// outside catalog (api-evangelist's Agent Readiness) therefore described this
// origin from the outside, and its rubric scores self-description separately
// from being described: an APIs.json the provider hosts, and an RFC 9727
// api-catalog at the well-known path. Both are now generated from SURFACE in
// src/connect.ts ("catalogs").
//
// WHAT AN INDEX CAN GET WRONG, and what is pinned here against each:
//   1. It names a URL the router does not serve. Every URL on this origin
//      that either document carries is fetched through the router and must
//      answer 200 -- the same completeness check the door's own routes get.
//   2. It is served as the wrong type. RFC 9727 mandates application/
//      linkset+json with the RFC's profile; json() would answer
//      application/json unless the router overrides it, so the exact header
//      is asserted, not a prefix.
//   3. It carries a contact. The disclosure boundary is no mailbox, no
//      social handle, no person; an APIs.json maintainer block is where those
//      would appear. Neither document may contain "@".
//   4. It drifts from the route table. APIS_JSON_PROPERTIES is a side table
//      keyed by SURFACE path, and a key that is not a SURFACE path is a dead
//      link waiting for the next rename. UNCLOCKED_DOCUMENTS is pinned to the
//      `clock: false` lines in src/index.ts the same way test/surface.test.ts
//      pins SURFACE to the router's literals.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import {
  APIS_JSON_PROPERTIES,
  APIS_JSON_CREATED,
  APIS_JSON_MODIFIED,
  APIS_JSON_SPEC_VERSION,
  API_CATALOG_MEDIA_TYPE,
  UNCLOCKED_DOCUMENTS,
} from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROUTER = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const ORIGIN = "https://1f916.ai";

type Property = { type: string; url: string; description?: string };
type ApisJson = {
  name: string;
  description: string;
  url: string;
  created: string;
  modified: string;
  specificationVersion: string;
  apis: { aid: string; name: string; description: string; humanURL: string; baseURL: string; properties: Property[] }[];
  common: Property[];
  maintainers: Record<string, string>[];
  now?: unknown;
  now_utc?: unknown;
};
type Linkset = { linkset: ({ anchor: string } & Record<string, unknown>)[] };

async function fetchBoth() {
  const { env } = sqliteTestEnv(schema);
  const apis = await worker.fetch(new Request(`${ORIGIN}/apis.json`), env);
  const catalog = await worker.fetch(new Request(`${ORIGIN}/.well-known/api-catalog`), env);
  return { env, apis, catalog, apisText: await apis.clone().text(), catalogText: await catalog.clone().text() };
}

// Every absolute URL on this origin inside a document, wherever it sits.
function urlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/https:\/\/1f916\.ai[^"\s]*/g)].map((m) => m[0]))];
}

test("/apis.json is served: APIs.json 0.23 root, one API, the mandatory fields, no clock", async () => {
  const { apis } = await fetchBoth();
  assert.equal(apis.status, 200);
  assert.match(apis.headers.get("content-type") ?? "", /^application\/json/);
  const doc = (await apis.json()) as ApisJson;
  assert.equal(doc.url, `${ORIGIN}/apis.json`, "url is the document's own location");
  assert.match(doc.aid, /^1f916\.ai:/, "root aid is [root domain]:[string]");
  assert.equal(doc.specificationVersion, APIS_JSON_SPEC_VERSION);
  assert.equal(doc.created, APIS_JSON_CREATED);
  assert.equal(doc.modified, APIS_JSON_MODIFIED);
  for (const k of ["name", "description"] as const) assert.ok(doc[k].length > 0, `${k} is mandatory`);
  // The dates are calendar dates, ordered, and not in the future: a `modified`
  // ahead of the clock would be a hand-set constant nobody checked.
  const day = /^\d{4}-\d{2}-\d{2}$/;
  assert.match(doc.created, day);
  assert.match(doc.modified, day);
  assert.ok(doc.created <= doc.modified, "modified is not before created");
  assert.ok(doc.modified <= new Date().toISOString().slice(0, 10), "modified is not in the future");
  // Unclocked on purpose: the document declares its own dates.
  assert.equal(doc.now, undefined);
  assert.equal(doc.now_utc, undefined);
  assert.equal(doc.apis.length, 1, "one API: the router serves one surface");
  const api = doc.apis[0];
  assert.match(api.aid, /^1f916\.ai:/, "aid is [root domain]:[string]");
  assert.equal(api.humanURL, `${ORIGIN}/`);
  assert.equal(api.baseURL, ORIGIN, "baseURL agrees with the OpenAPI servers entry");
  assert.ok(api.properties.length >= 4, "the API carries its discovery documents as properties");
  assert.ok(doc.common.length >= 1, "origin-wide documents live under common[]");
});

test("/.well-known/api-catalog is an RFC 9727 linkset served with the RFC's exact media type", async () => {
  const { catalog } = await fetchBoth();
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("content-type"), API_CATALOG_MEDIA_TYPE, "the header is the RFC's, profile included");
  assert.equal(API_CATALOG_MEDIA_TYPE, 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  const doc = (await catalog.json()) as Linkset;
  assert.deepEqual(Object.keys(doc), ["linkset"], "RFC 9264 4.2: linkset is the sole root member");
  for (const ctx of doc.linkset) assert.ok(typeof ctx.anchor === "string", "every link context names its anchor");
  const byAnchor = Object.fromEntries(doc.linkset.map((c) => [c.anchor, c])) as Record<string, Record<string, { href: string; type?: string }[]>>;
  const self = byAnchor[`${ORIGIN}/.well-known/api-catalog`];
  assert.ok(self, "the catalog is its own first context");
  assert.deepEqual(self.item.map((l) => l.href), [`${ORIGIN}/`], "one item: the one API, anchored at the origin");
  const api = byAnchor[`${ORIGIN}/`];
  assert.ok(api, "the API's context is present");
  assert.deepEqual(api["service-desc"].map((l) => l.href), [`${ORIGIN}/openapi.json`]);
  assert.ok(api["service-doc"].some((l) => l.href === `${ORIGIN}/`), "service-doc names the front door");
  assert.ok(api["service-meta"].some((l) => l.href === `${ORIGIN}/apis.json`), "service-meta names the APIs.json index");
  assert.ok(api["service-meta"].some((l) => l.href === `${ORIGIN}/.well-known/mcp.json`), "service-meta names the MCP manifest");
  // The relations are only the three from RFC 8631 that fit. `status` in
  // particular is absent: nothing served is an API-health page.
  for (const ctx of doc.linkset) {
    const rels = Object.keys(ctx).filter((k) => k !== "anchor").sort();
    for (const rel of rels) assert.ok(["item", "service-desc", "service-doc", "service-meta"].includes(rel), `${rel} is not a relation this catalog claims`);
  }
  // Every link's declared type is what the router serves at that href.
  const { env } = sqliteTestEnv(schema);
  for (const ctx of doc.linkset) {
    for (const rel of Object.keys(ctx).filter((k) => k !== "anchor")) {
      for (const l of ctx[rel] as { href: string; type?: string }[]) {
        if (!l.type) continue;
        const live = await worker.fetch(new Request(l.href), env);
        assert.ok((live.headers.get("content-type") ?? "").startsWith(l.type), `${l.href}: declared ${l.type}, served ${live.headers.get("content-type")}`);
      }
    }
  }
});

test("every URL either index carries is served 200 by the router", async () => {
  const { env, apisText, catalogText } = await fetchBoth();
  const urls = [...new Set([...urlsIn(apisText), ...urlsIn(catalogText)])];
  assert.ok(urls.length >= 10, `the two documents name the discovery surface (${urls.length} urls)`);
  for (const u of urls) {
    const res = await worker.fetch(new Request(u), env);
    assert.equal(res.status, 200, `${u} is a dead link in the index`);
  }
  // And nothing off this origin: an index of ourselves names only ourselves.
  for (const text of [apisText, catalogText]) {
    for (const m of text.matchAll(/https?:\/\/([^/"\s]+)/g)) {
      assert.ok(m[1] === "1f916.ai" || m[1] === "www.rfc-editor.org", `${m[0]} is not this origin (the RFC profile URI is the one permitted outside reference)`);
    }
  }
});

test("neither index carries a contact: no '@' anywhere in either document", async () => {
  const { apisText, catalogText } = await fetchBoth();
  assert.ok(!apisText.includes("@"), "apis.json carries no mailbox or handle");
  assert.ok(!catalogText.includes("@"), "api-catalog carries no mailbox or handle");
  const doc = JSON.parse(apisText) as ApisJson;
  for (const m of doc.maintainers) {
    assert.equal(m.email, undefined, "no email on a maintainer");
    assert.equal(m["x-twitter"], undefined, "no social handle on a maintainer");
  }
});

test("APIS_JSON_PROPERTIES names only SURFACE paths, and every property url is one of them", async () => {
  const paths = new Set(SURFACE.map((r) => r.path));
  for (const p of Object.keys(APIS_JSON_PROPERTIES)) {
    assert.ok(paths.has(p), `${p} is in the side table but not in SURFACE`);
    assert.ok(!p.includes(":"), `${p} is templated; an index cannot link a template`);
  }
  const { apisText } = await fetchBoth();
  const doc = JSON.parse(apisText) as ApisJson;
  const props = [...doc.apis[0].properties, ...doc.common];
  assert.equal(props.length, Object.keys(APIS_JSON_PROPERTIES).length, "every side-table line is emitted exactly once");
  for (const p of props) {
    const path = p.url.slice(ORIGIN.length);
    assert.ok(paths.has(path), `${p.url} names a route SURFACE does not have`);
    assert.equal(p.type, APIS_JSON_PROPERTIES[path].type);
    assert.ok(/^[A-Z][A-Za-z]+$/.test(p.type), `${p.type} is spelled as an APIs.json reserved keyword`);
  }
});

test("UNCLOCKED_DOCUMENTS is exactly the set of clock:false lines in the router", async () => {
  const src = readFileSync(ROUTER, "utf8");
  const found = new Set<string>();
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("if (") || !/clock:\s*false/.test(line)) continue;
    for (const m of line.matchAll(/path === "([^"]+)"/g)) found.add(m[1]);
  }
  assert.deepEqual([...found].sort(), [...UNCLOCKED_DOCUMENTS].sort(), "a clock:false line without a decision in UNCLOCKED_DOCUMENTS, or the reverse");
  // And the set is true on the wire: none of them carries the stamp, and the
  // OpenAPI description of each says so instead of promising it.
  const { env } = sqliteTestEnv(schema);
  const oa = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as { paths: Record<string, { get: { responses: { "200": { description: string } } } }> };
  for (const p of UNCLOCKED_DOCUMENTS) {
    const body = (await (await worker.fetch(new Request(`${ORIGIN}${p}`), env)).json()) as { now?: unknown };
    assert.equal(body.now, undefined, `${p} must not carry now`);
    assert.doesNotMatch(oa.paths[p].get.responses["200"].description, /^JSON; every object carries/, `${p} openapi 200 must not promise the clock`);
  }
});
