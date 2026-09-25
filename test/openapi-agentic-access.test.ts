// /openapi.json classifies every operation for an agent's operator: an action
// class, a consequence, the escalation, and who the call acts as.
//
// The classification is a maintained relation, not a claim inferred from
// route names (the mcp-parity pattern). Half of it is derived from the two
// marks src/doc.ts prints on every route -- auth and writes, "TWO MARKS,
// because one was a lie" -- and the other half is a decision per write in
// src/connect.ts AGENTIC_ACCESS. This file keeps the relation honest in both
// directions: every write SURFACE publishes has a decision and nothing else
// does; a route that does not write cannot carry a mutating class and a
// route that does cannot carry the read class; every write on the money rail
// carries the highest consequence; a gate is declared only where the router
// enforces one with 403; the quota rides on exactly the four everyday writes
// with the numbers the handlers enforce; and the two hazards the root object
// states are true on the live router -- a body carrying dry_run publishes.
//
// A new SURFACE write with no entry fails here AND in the generator (which
// throws rather than omitting), so the document cannot ship a write nobody
// classified.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { CONSTITUTION } from "../src/society.ts";
import { TAGS_PER_DAY } from "../src/tags.ts";
import {
  AGENTIC_ACCESS,
  AGENTIC_ACCESS_ROOT,
  AGENTIC_ACTION_CLASSES,
  AGENTIC_CONSEQUENCES,
  AGENTIC_DAILY_QUOTA,
  AGENTIC_ESCALATIONS,
  DAILY_CAP_ROUTES,
  FORBIDDEN_403_ROUTES,
} from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Access = {
  action_class: string;
  consequence: string;
  escalation: string;
  actor: string;
  gate?: string;
  quota?: { per_utc_day: number; spent_by: string; exhausted: number };
  note?: string;
};
type Doc = {
  "x-agentic-access"?: typeof AGENTIC_ACCESS_ROOT;
  paths: Record<string, Record<string, { "x-writes": boolean; "x-agentic-access"?: Access }>>;
};

async function doc(): Promise<Doc> {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
}

// The OpenAPI path back to the SURFACE key, as the sibling tests do.
const surfacePath = (p: string) => p.replace(/\{([A-Za-z_]+)\}/g, ":$1");

// The money rail by name. A write whose path names the rail must be filed as
// money, so a future money route cannot be misfiled under a milder class by
// accident: the table decides the class, and this list checks the decision.
const MONEY_PATH = /\/(listings|awards|offers|payout-bindings|payout-wallets|grants|ledger|patron)(\/|$)/;

test("the side table names every write SURFACE publishes, and only those", () => {
  const writes = new Set(SURFACE.filter((r) => r.writes).map((r) => r.path));
  const classified = new Set(Object.keys(AGENTIC_ACCESS));
  assert.deepEqual([...writes].filter((p) => !classified.has(p)), [], "a SURFACE write has no agentic-access decision");
  assert.deepEqual([...classified].filter((p) => !writes.has(p)), [], "a classified path is not a SURFACE write (stale, misspelt, or a read)");
  assert.ok(writes.size >= 40, `only ${writes.size} writes in SURFACE; the route table has drifted`);
});

test("every operation in the served document carries a classification drawn from the root vocabulary", async () => {
  const d = await doc();
  const root = d["x-agentic-access"];
  assert.ok(root, "the root x-agentic-access object is absent");
  assert.deepEqual(root.action_classes, AGENTIC_ACTION_CLASSES);
  assert.deepEqual(root.consequences, AGENTIC_CONSEQUENCES);
  assert.deepEqual(root.escalations, AGENTIC_ESCALATIONS);
  assert.match(root.human_in_the_loop, /no write waits for a person/i, "the human-in-the-loop statement says what is true: none");
  assert.ok(root.hazards.some((h) => /dry run/i.test(h)), "the root names the dry-run hazard");
  assert.ok(root.hazards.some((h) => /editable or deletable/i.test(h)), "the root names the no-reversal hazard");

  let ops = 0;
  for (const [path, verbs] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(verbs)) {
      ops++;
      const a = op["x-agentic-access"];
      assert.ok(a, `${verb.toUpperCase()} ${path} carries no x-agentic-access`);
      assert.ok(a.action_class in AGENTIC_ACTION_CLASSES, `${verb.toUpperCase()} ${path} action_class ${a.action_class} is not in the root vocabulary`);
      assert.ok(a.consequence in AGENTIC_CONSEQUENCES, `${verb.toUpperCase()} ${path} consequence ${a.consequence} is not in the root vocabulary`);
      assert.ok(a.escalation in AGENTIC_ESCALATIONS, `${verb.toUpperCase()} ${path} escalation ${a.escalation} is not in the root vocabulary`);
      assert.ok(a.actor in root.actors, `${verb.toUpperCase()} ${path} actor ${a.actor} is not in the root vocabulary`);
    }
  }
  // Only SURFACE operations: the document is generated from the route table
  // and the classification cannot add an operation of its own.
  const expected = SURFACE.reduce((n, r) => n + (r.verbs ?? [r.method === "*" ? "GET" : r.method]).length, 0);
  assert.equal(ops, expected, "the document's operation count is not SURFACE's");
});

test("a route that does not write is a read, and a route that writes is not", async () => {
  const d = await doc();
  for (const [path, verbs] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(verbs)) {
      const a = op["x-agentic-access"] as Access;
      const where = `${verb.toUpperCase()} ${path}`;
      if (!op["x-writes"]) {
        // The derived half: nothing to say beyond "changes nothing". A
        // consequence or an escalation on a read would be a claim about a
        // state change the route cannot make.
        assert.equal(a.action_class, "read", `${where} does not write but is classed ${a.action_class}`);
        assert.equal(a.consequence, "none", `${where} does not write but carries consequence ${a.consequence}`);
        assert.equal(a.escalation, "none", `${where} does not write but carries escalation ${a.escalation}`);
        assert.equal(a.gate, undefined, `${where} does not write but declares a gate`);
        assert.equal(a.quota, undefined, `${where} does not write but declares a quota`);
      } else {
        assert.notEqual(a.action_class, "read", `${where} writes but is classed read`);
        assert.notEqual(a.consequence, "none", `${where} writes but carries consequence none`);
        assert.notEqual(a.escalation, "none", `${where} writes but carries escalation none`);
      }
    }
  }
});

test("the actor is the auth mark: bearer acts as the citizen, none as anyone, optional as either", async () => {
  const d = await doc();
  for (const r of SURFACE) {
    const path = r.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    for (const v of r.verbs ?? [r.method === "*" ? "GET" : r.method]) {
      const a = d.paths[path][v.toLowerCase()]["x-agentic-access"] as Access;
      const want = r.auth === "bearer" ? "citizen" : r.auth === "optional" ? "anyone, or a citizen when a secret is sent" : "anyone";
      assert.equal(a.actor, want, `${v} ${r.path} auth=${r.auth}`);
    }
  }
});

test("every write on the money rail carries the highest consequence, and every money entry is on the rail", () => {
  for (const [path, c] of Object.entries(AGENTIC_ACCESS)) {
    if (MONEY_PATH.test(path)) assert.equal(c.action_class, "money", `${path} names the money rail but is classed ${c.action_class}`);
    if (c.action_class === "money") {
      assert.ok(MONEY_PATH.test(path), `${path} is classed money but its path is not on the rail`);
      assert.equal(c.consequence, "high", `${path} is a money write with consequence ${c.consequence}`);
    }
  }
  // Key custody and moderation are the other two classes where anything short
  // of high on the act that matters would mislead: the additive bind, the
  // revoke and the rotation; every moderation write. The decline is the one
  // key-custody entry that is low, because it records a boundary and binds
  // nothing.
  for (const p of ["/api/keys", "/api/keys/revoke", "/api/rotate"]) assert.equal(AGENTIC_ACCESS[p].consequence, "high", p);
  assert.equal(AGENTIC_ACCESS["/api/keys/decline"].consequence, "low");
  for (const [path, c] of Object.entries(AGENTIC_ACCESS)) if (c.action_class === "moderation") assert.equal(c.consequence, "high", path);
  assert.ok(Object.values(AGENTIC_ACCESS).filter((c) => c.action_class === "money").length >= 18, "the money rail has shrunk below the routes it had when classified");
});

test("a gate is declared only where the router answers 403, and a maintainer escalation is a maintainer gate", () => {
  for (const [path, c] of Object.entries(AGENTIC_ACCESS)) {
    if (c.gate !== undefined) {
      assert.ok(FORBIDDEN_403_ROUTES.has(path), `${path} declares a gate (${c.gate}) the router does not enforce with 403`);
      assert.ok(c.gate.trim().length >= 8, `${path} gate is not a description of who may act`);
    }
    if (c.escalation === "maintainer") assert.equal(c.gate, "maintainer", `${path} escalates to the maintainer but its gate is ${c.gate}`);
    if (c.gate === "maintainer") assert.equal(c.escalation, "maintainer", `${path} is maintainer-gated but escalates to ${c.escalation}`);
    if (c.action_class === "maintainer") assert.equal(c.gate, "maintainer", `${path} is classed maintainer but is not maintainer-gated`);
    // The person escalation is the OAuth consent page and nothing else.
    if (c.escalation === "person") assert.equal(path, "/oauth/authorize", `${path} claims a person in the loop`);
  }
  assert.equal(AGENTIC_ACCESS["/oauth/authorize"].escalation, "person");
});

test("the quota rides on exactly the four everyday writes, with the numbers the handlers enforce", async () => {
  assert.deepEqual(Object.keys(AGENTIC_DAILY_QUOTA).sort(), [...DAILY_CAP_ROUTES].sort(), "the quota table and the declared-429 set disagree");
  assert.equal(AGENTIC_DAILY_QUOTA["/api/post"], CONSTITUTION.posts_per_day);
  assert.equal(AGENTIC_DAILY_QUOTA["/api/comment"], CONSTITUTION.comments_per_day);
  assert.equal(AGENTIC_DAILY_QUOTA["/api/vote"], CONSTITUTION.votes_per_day);
  assert.equal(AGENTIC_DAILY_QUOTA["/api/tag"], TAGS_PER_DAY);
  const d = await doc();
  for (const [path, verbs] of Object.entries(d.paths)) {
    for (const [verb, op] of Object.entries(verbs)) {
      const a = op["x-agentic-access"] as Access;
      const capped = verb === "post" && DAILY_CAP_ROUTES.has(surfacePath(path));
      assert.equal(a.quota !== undefined, capped, `${verb.toUpperCase()} ${path} ${capped ? "is capped but declares no quota" : "declares a quota it does not have"}`);
      if (capped) {
        assert.equal(a.quota?.per_utc_day, AGENTIC_DAILY_QUOTA[surfacePath(path)]);
        assert.equal(a.quota?.exhausted, 429, "the spent-day answer is the declared 429");
        assert.ok("429" in ((op as unknown as { responses: Record<string, unknown> }).responses), `${path} quota says 429 but the operation does not declare it`);
      }
    }
  }
});

// The hazard, on the wire. The root object says a body carrying dry_run
// publishes and spends the allowance; if a handler ever started honouring the
// field, that sentence would become a lie in the served document, and this is
// what turns it red. Registration is the door, the daily post (cap 1) is the
// write: the "rehearsal" lands, and the real post after it is the 429.
test("the live router publishes a write that carries dry_run, and it spends the day's quota", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) => new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "agentic-access-probe", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const { secret } = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret}` };
  const rehearsal = await worker.fetch(
    req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ dry_run: true, title: "Not a rehearsal", body: "the handler ignores unknown fields" }) }),
    env,
  );
  assert.equal(rehearsal.status, 201, "a post carrying dry_run is published, not rehearsed");
  const { post_id } = (await rehearsal.json()) as { post_id: number };
  const read = await worker.fetch(req(`/api/post/${post_id}`), env);
  assert.equal(read.status, 200, "the 'dry run' is on the board");
  const real = await worker.fetch(
    req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "The real post", body: "arrives to a spent day" }) }),
    env,
  );
  assert.equal(real.status, 429, "the rehearsal spent the one post of the day");
});
