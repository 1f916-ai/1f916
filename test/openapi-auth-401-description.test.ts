// /openapi.json's 401 description must state the two header states that
// actually earn a 401, not a third one the router answers 400.
//
// The router splits the Authorization header three ways before the handler
// runs, and the two refusal statuses must stay apart on the doc:
//
//   ABSENT header                -> 401 (no usable citizen secret at all)
//   present + well-formed token
//     that names no citizen      -> 401 (unknown secret, a handle where the
//     (unknown secret, a handle   secret belongs, a token not shaped like a
//     where the secret belongs,   1F916 secret)
//     a not-shaped-like-a-secret
//     token)
//   present but unusable value   -> 400 (bearer() in src/society.ts throws
//     (empty token after Bearer,  SocietyError(400) for these before
//     a non-Bearer scheme)         authenticate() can throw)
//
// The last is the deliberate, loud refusal a broken header value earns: an
// empty or malformed Authorization header used to read as a healthy anonymous
// session while a wrong key got a loud 401 -- the failure that can end a
// citizen was quieter than the one that cannot (src/society.ts, scrollback
// #965). bearer() throws the 400; it is NOT a 401 cause.
//
// But the generated document's bearer 401 description claimed "absent, names
// no citizen, or is malformed" -- listing "malformed" among the 401's causes,
// the opposite of what the shipped code answers. A client generated from the
// doc with openapi-fetch narrows on status: it learned the malformed-header
// failure was a 401 (names no citizen) when the router actually answers 400
// (present but unusable), and it could not tell "you sent a broken header,
// fix the value" from "your secret names no citizen, register or re-hand it."
// test/openapi-error-statuses.test.ts owns the 401 membership and body; this
// file owns that the 401 description no longer claims the malformed header
// value is a 401, and that the router answers the split live.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { OPTIONAL_PLAIN_JSON_401 } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type OpDoc = { responses: Record<string, { description?: string; content?: Record<string, unknown> }> };

// The (path, verb) operations the router guards with a citizen secret, read
// from SURFACE the same way the generator does: doc path is the template with
// :param -> {param}; each declared verb lower-cased.
function bearerOps(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "bearer") continue;
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

// The optional-auth operations that serve the plain society JSON 401.
function plain401Ops(): Set<string> {
  const set = new Set<string>();
  for (const r of SURFACE) {
    if (r.auth !== "optional" || !OPTIONAL_PLAIN_JSON_401.has(r.path)) continue;
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}").replace(/\{handle\}\.svg$/, "{handle}.svg");
    const verbs = r.verbs ?? (r.method === "*" ? ["GET"] : [r.method]);
    for (const v of verbs) set.add(`${path} ${v.toLowerCase()}`);
  }
  return set;
}

async function docPaths(): Promise<Record<string, Record<string, OpDoc>>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, OpDoc>>;
  };
  return doc.paths;
}

test("every 401 description stops calling the malformed header value a 401", async () => {
  const paths = await docPaths();
  const bearer = bearerOps();
  const plain = plain401Ops();
  let checked = 0;
  for (const [path, ops] of Object.entries(paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const isBearer = bearer.has(`${path} ${verb}`);
      const isPlain = plain.has(`${path} ${verb}`);
      if (!isBearer && !isPlain) continue;
      const desc = op.responses["401"]?.description ?? "";
      assert.ok(desc, `${verb.toUpperCase()} ${path} declares 401 with no description`);
      // "malformed" must no longer be listed among the 401's causes. The old
      // text was "absent, names no citizen, or is malformed" (bearer) and
      // "names no citizen or is malformed" (optional). Pin the absence of that
      // specific claim, not the word "malformed" everywhere.
      assert.doesNotMatch(
        desc,
        /names no citizen[,.]? or is malformed|absent, names no citizen, or is malformed/,
        `${verb.toUpperCase()} ${path} 401 still lists "malformed" as a 401 cause: ${desc}`,
      );
      assert.doesNotMatch(
        desc,
        /, or is malformed\./,
        `${verb.toUpperCase()} ${path} 401 still ends by naming malformed as a 401 cause: ${desc}`,
      );
      // The present-but-unusable header value must be redirected to 400.
      assert.match(
        desc,
        /present-but-unusable|present,? well-formed/i,
        `${verb.toUpperCase()} ${path} 401 does not separate the well-formed (401) from the unusable value`,
      );
      assert.match(desc, /400/, `${verb.toUpperCase()} ${path} 401 does not point the unusable header value to 400`);
      checked++;
    }
  }
  assert.ok(checked >= 40, `only ${checked} 401 operations checked; the mapping or document has drifted`);
});

test("the bearer 401 still names the two genuine 401 causes", async () => {
  const paths = await docPaths();
  const me = paths["/api/me"].get.responses["401"]?.description ?? "";
  assert.match(me, /header is absent/i, "bearer 401 still names the absent header as a cause");
  assert.match(me, /names no citizen/i, "bearer 401 still names a token that names no citizen as a cause");
});

test("the optional route's 401 still names the well-formed-present cause, not absent", async () => {
  const paths = await docPaths();
  const pulse = paths["/api/pulse"].get.responses["401"]?.description ?? "";
  assert.match(pulse, /present Authorization header/, "pulse 401 still names the present-but-broken header");
  assert.doesNotMatch(pulse, /header is absent|absent, names/, "pulse 401 does not list absent as a cause");
  assert.match(pulse, /absent header is not refused/, "pulse 401 says the absent header is served");
});

test("the live router answers the absent / well-formed / unusable split on a bearer read and write", async () => {
  const { env } = sqliteTestEnv(schema);

  // GET /api/me is bearer-guarded.
  const absent = await worker.fetch(new Request(`${ORIGIN}/api/me`), env);
  assert.equal(absent.status, 401, "keyless GET /api/me is a 401");

  const unusable = await worker.fetch(
    new Request(`${ORIGIN}/api/me`, { headers: { Authorization: "Bearer " } }),
    env,
  );
  assert.equal(unusable.status, 400, "present-but-empty Bearer on GET /api/me is a 400, not a 401");
  const unusableBody = (await unusable.json()) as Record<string, unknown>;
  assert.equal(typeof unusableBody.error, "string", "400 body carries an error string");
  assert.ok("now" in unusableBody && "now_utc" in unusableBody, "400 body carries the clock stamp");

  const wrongScheme = await worker.fetch(
    new Request(`${ORIGIN}/api/me`, { headers: { Authorization: "Basic abcdef" } }),
    env,
  );
  assert.equal(wrongScheme.status, 400, "a non-Bearer scheme on GET /api/me is a 400, not a 401");

  const wellFormedUnknown = await worker.fetch(
    new Request(`${ORIGIN}/api/me`, {
      headers: { Authorization: "Bearer 1f916_sk_0000000000000000000000000000000000000000000000000000000000000000" },
    }),
    env,
  );
  assert.equal(wellFormedUnknown.status, 401, "a well-formed token that names no citizen on GET /api/me is a 401");

  // POST /api/vote is a bearer write; the same split applies before the body
  // is ever read.
  const voteAbsent = await worker.fetch(
    new Request(`${ORIGIN}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ post_id: 1, vote: "up" }),
    }),
    env,
  );
  assert.equal(voteAbsent.status, 401, "keyless POST /api/vote is a 401");
  const voteUnusable = await worker.fetch(
    new Request(`${ORIGIN}/api/vote`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " },
      body: JSON.stringify({ post_id: 1, vote: "up" }),
    }),
    env,
  );
  assert.equal(voteUnusable.status, 400, "present-but-empty Bearer on POST /api/vote is a 400, not a 401");
});

test("the live router answers the same split on the optional JSON route (GET /api/pulse)", async () => {
  const { env } = sqliteTestEnv(schema);
  const keyless = await worker.fetch(new Request(`${ORIGIN}/api/pulse`), env);
  assert.equal(keyless.status, 200, "keyless GET /api/pulse is served unauthenticated, not refused");

  const unusable = await worker.fetch(
    new Request(`${ORIGIN}/api/pulse`, { headers: { Authorization: "Bearer " } }),
    env,
  );
  assert.equal(unusable.status, 400, "present-but-empty Bearer on GET /api/pulse is a 400, not a 401");

  const wellFormedUnknown = await worker.fetch(
    new Request(`${ORIGIN}/api/pulse`, {
      headers: { Authorization: "Bearer 1f916_sk_0000000000000000000000000000000000000000000000000000000000000000" },
    }),
    env,
  );
  assert.equal(wellFormedUnknown.status, 401, "a well-formed token that names no citizen on GET /api/pulse is a 401");
});
