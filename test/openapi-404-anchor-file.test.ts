// /openapi.json declares the PLAIN clocked-error 404 the keyless client meets
// on the two anchor file reads, not only the success status.
//
// GET /api/anchors/:id.ots and GET /api/anchors/:id.txt answer, when the anchor
// id in the path names no anchor row, the same clocked JSON error body as every
// other refused read: now, now_utc and a single prose `error` string, with no
// id_class discriminator. (src/anchors.ts anchorFile returns null when the row
// is absent -- or when the .ots route's anchor carries no OpenTimestamps proof
// -- and anchorFileResponse in src/index.ts turns that null into
// SocietyError(404, "no anchor <id>...").) The generated document declared a
// lone success code (200) on both, so a client built with openapi-fetch
// narrows on status and types the miss `never`: it cannot tell "no anchor at
// that id" from "the endpoint is missing", and the absence -- the case that
// tells a walker nothing to retry -- is the one it cannot distinguish.
//
// The SUCCESS body of these two routes is a file (an octet-stream .ots proof or
// a plain .txt checkpoint text), not JSON; that is a different concern handled
// by the `produces` annotation on the surface (the 200 content type), and is
// kept out of this file. The wrong-door 404 on a non-numeric id (the body
// carries did_you_mean / hint) is a different outcome and stays undeclared, as
// it is. This file is about the in-route ABSENCE 404, which the doc omits.
//
// This file keeps the declaration honest against the router in-process: the two
// anchor file reads declare the plain 404 and no other route does via this set,
// the declared body is the clocked JSON error with no id_class, and the live
// router actually serves that body on both.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { ANCHOR_FILE_404_ROUTES, CHECKPOINT_PROOF_404_ROUTES, MANDATE_404_ROUTES, PLAIN_404_ROUTES, SEALS_404_ROUTES, WRITE_TARGET_404_ROUTES } from "../src/connect.ts";

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

test("ANCHOR_FILE_404_ROUTES is exactly the two anchor file reads", () => {
  assert.deepEqual(
    [...ANCHOR_FILE_404_ROUTES].sort(),
    ["/api/anchors/:id.ots", "/api/anchors/:id.txt"],
    "the anchor-file-404 set drifted from the two anchor file reads",
  );
});

test("the two anchor file reads declare the plain 404, and the set adds exactly two to the sixteen declared", async () => {
  const doc = await docPaths();
  let checked = 0;
  let declared404 = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has404 = Object.keys(op.responses).includes("404");
      if (has404) declared404++;
      const isPlainLookup = verb === "get" && PLAIN_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      const isTyped = Boolean(op.responses["404"]?.content?.["application/json"]?.schema?.properties?.id_class);
      const isProse404 = path === "/grants/{slug}";
      const isAnchorFile = verb === "get" && ANCHOR_FILE_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      // The sibling 404 sets each declare the same clocked 404 through their
      // own membership (anchor files, proof reads, seals, content-target
      // writes); test/openapi-404-plain-miss.test.ts owns the full closed set.
      const tpl = path.replace(/\{([A-Za-z_]+)\}/g, ":$1");
      const isSibling =
        (verb === "get" && (ANCHOR_FILE_404_ROUTES.has(tpl) || CHECKPOINT_PROOF_404_ROUTES.has(tpl) || SEALS_404_ROUTES.has(tpl) || MANDATE_404_ROUTES.has(tpl))) ||
        (verb === "post" && WRITE_TARGET_404_ROUTES.has(tpl));
      const expected404 = isSibling || isPlainLookup || isProse404 || ((path === "/api/post/{id}" || path === "/api/comment/{id}") && isTyped);
      assert.equal(
        has404,
        expected404,
        `${verb.toUpperCase()} ${path} ${has404 ? "declares" : "does not declare"} a 404 unexpectedly`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
  // eleven plain lookup + two id_class + one prose grants door + two anchor
  // file reads = sixteen declared 404s, no more.
  // With every sibling set merged the document declares twenty-three.
  assert.equal(declared404, 25, `expected twenty-five declared 404s across the plain, typed, prose, mandate and sibling sets, got ${declared404}`);
});

test("the declared anchor-file-404 body is the clocked JSON error with no id_class", async () => {
  const doc = await docPaths();
  let checked = 0;
  for (const [path, ops] of Object.entries(doc)) {
    for (const [verb, op] of Object.entries(ops)) {
      const shouldBe = verb === "get" && ANCHOR_FILE_404_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      if (!shouldBe) continue;
      const body = op.responses["404"];
      assert.ok(body, `${path} anchor file read declares a 404`);
      assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `${path} 404 content is JSON`);
      const s = body.content?.["application/json"]?.schema;
      assert.ok(s && s.type === "object", `${path} 404 schema is an object`);
      const props = s?.properties as Record<string, unknown> | undefined;
      assert.ok(props && "error" in props, `${path} 404 schema names the error string`);
      assert.ok(!props?.id_class, `${path} anchor-file-404 body carries no id_class discriminator`);
      assert.deepEqual((s?.required as string[]) ?? [], ["error"], `${path} 404 required: only the error is always present`);
      assert.match(body.description ?? "", /no id_class/i, `${path} 404 description says the body carries no id_class`);
      checked++;
    }
  }
  assert.equal(checked, 2, `expected exactly the two anchor file reads, got ${checked}`);
});

test("the live router serves the clocked plain 404 on both anchor file reads, with no id_class", async () => {
  const { env } = sqliteTestEnv(schema);
  // A large anchor id that no anchor row names, on both file routes.
  const miss: [string, string, RegExp][] = [
    ["/api/anchors/999999999.ots", "the .ots proof route", /no anchor 999999999 carrying an OpenTimestamps proof/],
    ["/api/anchors/999999999.txt", "the .txt covered-text route", /no anchor 999999999/],
  ];
  for (const [p, what, expected] of miss) {
    const res = await worker.fetch(new Request(`${ORIGIN}${p}`), env);
    assert.equal(res.status, 404, `GET ${p} (${what}) answers 404 on a miss`);
    const ct = res.headers.get("content-type") ?? "";
    assert.match(ct, /application\/json/, `GET ${p} miss is JSON, not a file`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok("now" in body && "now_utc" in body, `${what} 404 body carries the clock stamp like every served object`);
    assert.equal(typeof body.error, "string", `${what} 404 body is a single prose error string`);
    assert.match(String(body.error), expected, `${what} 404 body names the missing anchor id`);
    assert.ok(!("id_class" in body), `${what} 404 body carries no id_class discriminator (that is the post/comment shape)`);
  }
  // The wrong-door side stays a different outcome: a non-numeric id is not a
  // miss on the file route, it is an unknown route, and answers the
  // did_you_mean / hint 404, which this set does not (and does not need to)
  // declare.
  const wrongDoor = await worker.fetch(new Request(`${ORIGIN}/api/anchors/not-a-number.ots`), env);
  assert.equal(wrongDoor.status, 404, "a non-numeric id is still a 404 on the wire");
  const wdBody = (await wrongDoor.json()) as Record<string, unknown>;
  assert.ok("did_you_mean" in wdBody || "hint" in wdBody, "the wrong-door 404 carries the did_you_mean / hint companions, not the plain clocked body");
});
