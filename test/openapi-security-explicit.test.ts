// Every operation in /openapi.json states its security requirement, and the
// open ones state it as `[]`.
//
// OAS 3.1 reads an absent operation-level `security` as "inherit the root
// requirement". This document declares none at the root, so an absent field
// and an explicit `[]` mean the same thing to the spec. They do not mean the
// same thing to a reader: redocly's security-defined rule flagged 76
// operations, and a client generated from the document cannot distinguish
// "this door is open" from "the author did not say" without the explicit form.
// (Gooseberry, #6183: the 76 errors left after the root fix.)
//
// The three shapes, keyed on SURFACE's auth column, which the router's own
// authenticate() calls are pinned against elsewhere:
//
//   none      -> []                            open; no scheme applies
//   bearer    -> [{ citizenSecret: [] }]       the citizen secret is required
//   optional  -> [{}, { citizenSecret: [] }]   the spec's spelling for "either"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Op = { security?: unknown[] };

test("every operation carries a security field, and its shape is SURFACE's auth column", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    security?: unknown;
    paths: Record<string, Record<string, Op>>;
  };
  assert.equal(doc.security, undefined, "no root requirement: every operation must say for itself");

  const byRoute = new Map<string, string>();
  for (const r of SURFACE) {
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) byRoute.set(`${v.toLowerCase()} ${path}`, r.auth);
  }

  let seen = 0;
  const shapes = { none: 0, bearer: 0, optional: 0 };
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      seen++;
      const auth = byRoute.get(`${verb} ${path}`);
      assert.ok(auth, `${verb.toUpperCase()} ${path} is in the document but not in SURFACE`);
      assert.ok(Array.isArray(op.security), `${verb.toUpperCase()} ${path} has no security field`);
      const want =
        auth === "bearer" ? [{ citizenSecret: [] }] :
        auth === "optional" ? [{}, { citizenSecret: [] }] :
        [];
      assert.deepEqual(op.security, want, `${verb.toUpperCase()} ${path}: auth=${auth}`);
      shapes[auth as keyof typeof shapes]++;
    }
  }
  assert.equal(seen, byRoute.size, "one operation per SURFACE verb");
  // The split as of this commit. A route changing auth class moves a number
  // here, which is a diff a reviewer reads.
  assert.deepEqual(shapes, { none: 86, bearer: 51, optional: 3 });
});
