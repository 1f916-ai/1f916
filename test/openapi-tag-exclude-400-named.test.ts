// The ?tag= / ?exclude= parameter descriptions in /openapi.json name the 400
// that PR #541 made live.
//
// Upstream merged ?tag/?exclude refusing invalid or over-cap values by name
// with a 400 where they previously applied the valid subset under a 200. That
// is a behavior change a client must see in the contract, not only in the
// error: a client that read the document, sent ?tag= with a mistyped tag, and
// used to get a confident (if narrower) feed now gets a refusal. The document
// carried these two parameters as bare {type: string} with no description, so
// the only place the new behavior was stated was the handlers' note text, not
// the parameter a generated client actually types.
//
// The descriptions are projected from one table (QUERY_PARAM_DESCRIPTIONS in
// src/query-params.ts, beside QUERY_PARAMS) so wording cannot drift from the
// guard: the same constant the router behavior and the openapi projection read.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { QUERY_PARAM_DESCRIPTIONS } from "../src/query-params.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Doc = {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string; description?: string }[] }>>;
};

async function doc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

const TAGGED_READS = ["/api/front", "/api/new"];

test("tag and exclude carry a description naming the 400 refusal on every read that takes them", async () => {
  const d = await doc();
  let checked = 0;
  for (const path of TAGGED_READS) {
    const op = d.paths[path]?.get;
    assert.ok(op, `GET ${path} in the document`);
    for (const name of ["tag", "exclude"]) {
      const param = (op.parameters ?? []).find((p) => p.in === "query" && p.name === name);
      assert.ok(param, `GET ${path} declares ?${name}`);
      const desc = param.description ?? "";
      assert.match(desc, /400/, `?${name} on ${path} names the 400`);
      assert.match(desc, /refus/i, `?${name} on ${path} says refused, not dropped`);
      checked++;
    }
  }
  assert.equal(checked, 4, "expected exactly the two tagged reads x two directions");
});

test("the description table covers exactly tag and exclude and matches the guard's rule", () => {
  assert.deepEqual(Object.keys(QUERY_PARAM_DESCRIPTIONS).sort(), ["exclude", "tag"]);
  for (const text of Object.values(QUERY_PARAM_DESCRIPTIONS)) {
    assert.ok(text.length <= 400, `description over 400 chars: ${text.length}`);
    assert.match(text, /8/, "names the 8-per-direction cap");
  }
});

test("the live router answers 400 naming the refused value, as the parameter description promises", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/api/new?tag=a-good-tag%2Cbad%7Etag`), env);
  assert.equal(res.status, 400, "invalid tag value is refused");
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /a-good-tag|bad~tag/, "the 400 names the refused value(s)");
});
