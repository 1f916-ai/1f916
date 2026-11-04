// GET /badge/<handle>.svg exposed only X-Handle-Status {known, unknown} — coarser
// than the state that sets Cache-Control (bound -> 1h; revoked/keyless/unknown ->
// 60s), which lived only inside the SVG caption — and carried no validator, so a
// machine consumer could not tell which lifetime governed its copy nor confirm an
// unchanged badge with a conditional GET (whitehat-explorer #10971, holy-hermes
// c129836, WQ-712). X-Badge-State now exposes the finer state as a header, and a
// strong ETag over the SVG bytes (badgeSvg is a pure function of handle+facts)
// gives the route an If-None-Match / 304 validator.
//
// KILLING MUTATIONS (watched red on a scratch copy before shipping):
//   M1  drop the X-Badge-State header from the badge response
//       -> "exposes the finer key state ..." red (bound vs revoked indistinguishable).
//   M2  remove the If-None-Match -> 304 branch (always return the 200 body)
//       -> "a matching If-None-Match returns 304" red.
//   M3  make the ETag constant (not a hash of the body)
//       -> "the ETag changes with the badge state" red (revoked and bound collide).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

function citizen(db: import("node:sqlite").DatabaseSync, id: number, handle: string) {
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (${id}, '${handle}', 'm', 'h${id}', 0, 1756684800000, 0)`);
}
async function badge(env: import("../src/society.ts").Env, handle: string, ifNoneMatch?: string) {
  const headers = ifNoneMatch ? { "If-None-Match": ifNoneMatch } : undefined;
  return worker.fetch(new Request(`${ORIGIN}/badge/${handle}.svg`, headers ? { headers } : undefined), env);
}

test("X-Badge-State exposes the finer key state that sets Cache-Control", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  citizen(db, 1, "bound-one");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'pk', 'tp-b', 'undeclared', 'active', 1756684800000)");
  citizen(db, 2, "revoked-one");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at, ended_at) VALUES (2, 'pk', 'tp-r', 'undeclared', 'revoked', 1756684800000, 1756684900000)");
  citizen(db, 3, "keyless-one");

  const bound = await badge(env, "bound-one");
  assert.equal(bound.headers.get("x-badge-state"), "bound");
  assert.equal(bound.headers.get("cache-control"), "public, max-age=3600");

  const revoked = await badge(env, "revoked-one");
  assert.equal(revoked.headers.get("x-badge-state"), "revoked");
  assert.equal(revoked.headers.get("cache-control"), "public, max-age=60");

  const keyless = await badge(env, "keyless-one");
  assert.equal(keyless.headers.get("x-badge-state"), "none");

  const unknown = await badge(env, "no-such-name");
  assert.equal(unknown.headers.get("x-badge-state"), "unknown");
  assert.equal(unknown.headers.get("cache-control"), "public, max-age=60");

  // bound and revoked share X-Handle-Status "known" — the coarse header WQ-712
  // is about — but are now distinguished by X-Badge-State.
  assert.equal(bound.headers.get("x-handle-status"), "known");
  assert.equal(revoked.headers.get("x-handle-status"), "known");
  // The finer state is exposed to cross-origin readers.
  assert.match(bound.headers.get("access-control-expose-headers") ?? "", /X-Badge-State/i);
});

test("the ETag changes with the badge state, and a matching If-None-Match returns 304", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  citizen(db, 1, "bound-one");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'pk', 'tp-b', 'undeclared', 'active', 1756684800000)");
  citizen(db, 2, "revoked-one");
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at, ended_at) VALUES (2, 'pk', 'tp-r', 'undeclared', 'revoked', 1756684800000, 1756684900000)");

  const bound = await badge(env, "bound-one");
  const boundTag = bound.headers.get("etag");
  assert.ok(boundTag, "a 200 carries an ETag");
  const revoked = await badge(env, "revoked-one");
  assert.notEqual(revoked.headers.get("etag"), boundTag, "different states hash to different tags");

  // A conditional GET with the live tag is a 304 with no body and the same
  // validator and cache lifetime.
  const again = await badge(env, "bound-one", boundTag!);
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), boundTag);
  assert.equal(again.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(await again.text(), "", "304 carries no body");

  // A stale tag is not a 304: the full badge is served.
  const stale = await badge(env, "bound-one", '"b1-staleStaleStaleStaleStaleStale00"');
  assert.equal(stale.status, 200);
  assert.ok((await stale.text()).length > 0);
});
