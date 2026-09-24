// /openapi.json declares the PLAIN clocked-error 404 a keyless client meets on
// the eleven JSON lookup reads, not only the success status.
//
// Every one of these reads -- one attestation, one offer, one listing, one
// grant, one grant proposal, one citizen record, one key set, one record
// dossier, one payout binding, one payout-binder funder-statement, one witness
// history -- answers, when the id or handle in the path names no live row, the
// same clocked JSON error body as every other refused read: now, now_utc and a
// single prose `error` string, with no id_class discriminator. (src/society.ts
// throws SocietyError(404) for each: readListing, readOffer, readAttestation,
// readGrant / readProposal, readCitizenRecord, readKeys, readRecord,
// readPayoutBinding, funderStatementFor, readWitnessHistory.)
//
// The two id-lookup reads that DO carry the id_class discriminator (readPost,
// readComment) are NOT here: their 404 is declared separately, with
// other_kind / other_route the plain body lacks (test/openapi-404-id-class.test.ts).
//
// The generated document declared a lone success code (200) on these eleven, so
// a client built with openapi-fetch narrows on status and types the miss
// `never`: it cannot tell "the row is gone" from "the endpoint is missing", and
// the absence -- the case that tells a walker nothing to retry -- is the one it
// cannot distinguish (the declaration side of the class the 401 / 400 / 429 /
// 304 declarations fixed on their own sides; Gooseberry, #6177 thread).
//
// This file keeps the declaration honest against the router in-process: every
// keyless lookup read declares the plain 404 and only they do, the declared
// body is the clocked JSON error with no id_class discriminator, and the live
// router actually serves that body on all eleven. The wire shape is pinned here;
// the id_class variant is pinned in test/typed-404-id-class-served.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { PLAIN_404_ROUTES, SEALS_404_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type SchemaOpDoc = {
  responses: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }>; description?: string }>;
};
async function docPaths(): Promise<Record<string, Record<string, SchemaOpDoc>>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, SchemaOpDoc>>;
  };
  return doc.paths;
}

test("PLAIN_404_ROUTES is exactly the eleven keyless JSON lookup reads", () => {
  assert.deepEqual(
    [...PLAIN_404_ROUTES].sort(),
    [
      "/api/attestations/:id",
      "/api/citizen/:handle",
      "/api/grants/:slug",
      "/api/grants/:slug/proposals/:id",
      "/api/keys/:handle",
      "/api/listings/:id",
      "/api/offers/:id",
      "/api/payout-bindings/:id",
      "/api/payout-bindings/:id/funder-statement",
      "/api/record/:handle",
      "/api/witnesses/:id/history",
    ],
    "the plain-404 set drifted from the eleven keyless JSON lookup reads",
  );
});

test("every keyless lookup read declares the plain 404, and only they do", async () => {
  const doc = await docPaths();
  let checked = 0;
  let declared404 = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has404 = Object.keys(op.responses).includes("404");
      if (has404) declared404++;
      const isPlain = verb === "get" && PLAIN_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      // A keyless lookup read either declares the plain 404 (this set) or, for
      // the two id-lookup reads, declares the typed id_class 404. Every other
      // operation declares no 404 at all.
      const isTyped = Boolean(op.responses["404"]?.content?.["application/json"]?.schema?.properties?.id_class);
      // The prose grants door (test/openapi-404-prose-grant.test.ts) also
      // declares a JSON 404 beside its 200 text page; it carries a 404 but is
      // not part of the keyless JSON lookup set, so allow it here.
      const isProse404 = path === "/grants/{slug}";
      // The memory-seal read (test/openapi-404-seals.test.ts) declares the
      // same clocked 404 through its own query-string set; allow it here.
      const isSeals404 = verb === "get" && SEALS_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      const expected404 = isPlain || isProse404 || isSeals404 || ((path === "/api/post/{id}" || path === "/api/comment/{id}") && isTyped);
      assert.equal(
        has404,
        expected404,
        `${verb.toUpperCase()} ${path} is ${isPlain ? "a plain-404 lookup and" : "not a plain-404 lookup and"} ${has404 ? "declares" : "does not declare"} a 404`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
  // eleven plain + two typed + one prose grants door + one seals read =
  // fifteen declared 404s, no more.
  assert.equal(declared404, 15, `expected fifteen declared 404s (eleven plain + two id_class + one prose grants door + one seals read), got ${declared404}`);
});

test("the declared plain-404 body is the clocked JSON error with no id_class", async () => {
  const doc = await docPaths();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const shouldBe = verb === "get" && PLAIN_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      if (!shouldBe) continue;
      const body = op.responses["404"];
      assert.ok(body, `${path} plain-404 read declares a 404`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${path} 404 content is JSON`);
      const s = body.content?.["application/json"]?.schema;
      assert.ok(s && s.type === "object", `${path} 404 schema is an object`);
      const props = s?.properties as Record<string, unknown> | undefined;
      assert.ok(props && "error" in props, `${path} 404 schema names the error string`);
      assert.ok(!props?.id_class, `${path} plain-404 body carries no id_class discriminator`);
      assert.deepEqual((s?.required as string[]) ?? [], ["error"], `${path} 404 required: only the error is always present`);
      assert.match(body.description ?? "", /no id_class/i, `${path} 404 description says the body carries no id_class`);
      checked++;
    }
  }
  assert.equal(checked, 11, `expected exactly the eleven plain-404 reads, got ${checked}`);
});

test("the live router serves the plain clocked 404 on all eleven, with no id_class", async () => {
  const { env } = sqliteTestEnv(schema);
  const miss: [string, string][] = [
    ["/api/attestations/999999", "one attestation"],
    ["/api/offers/999999", "one offer"],
    ["/api/listings/999999", "one listing"],
    ["/api/grants/no-such-slug", "one grant"],
    ["/api/grants/no-such-slug/proposals/999999", "one grant proposal"],
    ["/api/citizen/no-such-handle", "one citizen record"],
    ["/api/keys/no-such-handle", "one key set"],
    ["/api/record/no-such-handle", "one record dossier"],
    ["/api/payout-bindings/999999", "one payout binding"],
    ["/api/payout-bindings/999999/funder-statement", "one payout-binder funder-statement"],
    ["/api/witnesses/999999/history", "one witness history"],
  ];
  for (const [p, what] of miss) {
    const res = await worker.fetch(new Request(`${ORIGIN}${p}`), env);
    assert.equal(res.status, 404, `GET ${p} (${what}) answers 404 on a miss`);
    const ct = res.headers.get("content-type") ?? "";
    assert.match(ct, /application\/json/, `GET ${p} miss is JSON, not prose`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("now" in body && "now_utc" in body, `${what} 404 body carries the clock stamp like every served object`);
    assert.equal(typeof body.error, "string", `${what} 404 body is a single prose error string`);
    assert.ok(!("id_class" in body), `${what} 404 body carries no id_class discriminator (that is the post/comment shape)`);
  }
});
