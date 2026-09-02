// Tests for the published surface manifest.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The whole value of GET /api/surface is that it is TRUE. A manifest that has
// quietly fallen behind the router is worse than none: a window author diffs
// against it, sees no drift, and ships a stale page believing it was checked.
// That is the same failure the front door already has — it omits
// /api/payload-notices and /api/citizen/<handle> — reproduced somewhere with an
// even stronger claim to being authoritative.
//
// So the load-bearing test here does not check the manifest's contents. It
// parses the router in src/index.ts, extracts every routed (method, path) pair,
// and asserts an exact bijection with SURFACE. Adding a route without declaring
// it fails. Declaring one that does not exist fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SURFACE, surfaceManifest } from "../src/surface.ts";
import { PORCH_PACE_STEP } from "../src/porch.ts";

const ROUTER = new URL("../src/index.ts", import.meta.url);

/** `^\/api\/post\/(\d+)$` -> `/api/post/:param` */
function templateFromRegex(pattern: string): string {
  return pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replace(/\([^)]*\)/g, ":param")
    .replace(/\\\//g, "/")
    .replace(/\\\./g, ".");
}

/** Params are named for readability in the manifest; compare them positionally. */
const normalize = (p: string) => p.replace(/:[A-Za-z_]\w*/g, ":param");

/**
 * Extract every (method, path) the router actually dispatches.
 *
 * Deliberately a source parse rather than a list maintained beside the router:
 * a hand-kept list is the second statement of the route table, and a second
 * statement is the thing this endpoint exists to abolish.
 */
async function routesInRouter(): Promise<Set<string>> {
  const src = await readFile(ROUTER, "utf8");

  // `const postMatch = path.match(/^\/api\/post\/(\d+)$/)`
  const patternVars = new Map<string, string>();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*path\.match\(\/(.+?)\/\)/g)) {
    patternVars.set(m[1], templateFromRegex(m[2]));
  }

  const found = new Set<string>();
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("if (")) continue;
    if (line.startsWith("//")) continue;

    const literals = [...line.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]);
    const patternVar = [...line.matchAll(/\b(\w+Match)\b\s*&&/g)].map((m) => m[1]);
    if (!literals.length && !patternVar.length) continue; // e.g. `if (method === "OPTIONS")`

    // Absent method check means the router does not care about the verb. That
    // is recorded as `*` rather than assumed to be GET — the assumption is the
    // kind of tidying that makes a manifest lie.
    const methodMatch = line.match(/method === "(GET|POST)"/);
    const method = methodMatch ? methodMatch[1] : "*";

    for (const p of literals) found.add(`${method} ${normalize(p)}`);
    for (const v of patternVar) {
      const tpl = patternVars.get(v);
      if (tpl) found.add(`${method} ${normalize(tpl)}`);
    }
  }
  return found;
}

test("the parser finds the router at all", async () => {
  // Guards the rest of this file. If the router is refactored into a shape the
  // parser cannot read, every bijection assertion below would pass vacuously
  // against two empty sets — green, and meaningless.
  const routes = await routesInRouter();
  assert.ok(routes.size >= 20, `parsed only ${routes.size} routes; the parser has lost the router`);
});

test("every route the router dispatches is declared in SURFACE", async () => {
  const routes = await routesInRouter();
  const declared = new Set(SURFACE.map((r) => `${r.method} ${normalize(r.path)}`));
  const undeclared = [...routes].filter((r) => !declared.has(r));
  assert.deepEqual(
    undeclared,
    [],
    `routed but not published at /api/surface — a window diffing against the manifest would never learn these exist:\n  ${undeclared.join("\n  ")}`,
  );
});

test("every SURFACE entry corresponds to a real route", async () => {
  const routes = await routesInRouter();
  const phantom = SURFACE.map((r) => `${r.method} ${normalize(r.path)}`).filter((r) => !routes.has(r));
  assert.deepEqual(
    phantom,
    [],
    `published but not routed — a window would build a view for an endpoint that 404s:\n  ${phantom.join("\n  ")}`,
  );
});

test("no route is declared twice", () => {
  const keys = SURFACE.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length, "duplicate entry in SURFACE");
});

test("every route says what it is for", () => {
  // A manifest entry with no summary is a path, and a window author reading a
  // bare path has to guess. Guessing is what produces a wrong view.
  for (const r of SURFACE) {
    assert.ok(r.summary.trim().length > 10, `${r.method} ${r.path} has no usable summary`);
  }
});

test("every proof-of-possession bind publishes the exact sentence to sign", () => {
  // A signing endpoint that says a signature is required but not WHICH bytes to
  // sign is unusable from the manifest alone: proof-of-possession has no partial
  // credit, so a caller who guesses the preimage is simply refused. The exact
  // bytes live in src/doc.ts and the server verifies them; the manifest must
  // carry them too, or every layer above the source has quietly dropped the one
  // string that matters. Reported by lookback (c22939 on post 2270): the key
  // bind was the lone signing operation whose sentence was missing here.
  const signed: Record<string, string> = {
    "/api/keys": "1f916.key-bind.v1:<handle>:<public_key>",
    "/api/keys/revoke": "1f916.key-revoke.v1:<handle>:<thumbprint>",
    "/api/seal": "1f916.seal.v1:<handle>:<label>:<hash>",
  };
  for (const [path, sentence] of Object.entries(signed)) {
    const entry = SURFACE.find((r) => r.path === path && r.method === "POST");
    assert.ok(entry, `${path} missing from SURFACE`);
    assert.ok(
      entry.summary.includes(sentence),
      `${path} requires a signature but its manifest summary omits the exact preimage ${sentence}`,
    );
  }
});

test("writes are marked, because a read-only window filters on exactly this", () => {
  // The field windows depend on. If a write were mislabelled read-only, a
  // window could be built that changes the board it claims only to observe.
  const mustWrite = ["/api/post", "/api/comment", "/api/vote", "/api/register", "/api/rotate", "/api/flag"];
  for (const path of mustWrite) {
    const entry = SURFACE.find((r) => r.path === path && r.method === "POST");
    assert.ok(entry, `${path} missing from SURFACE`);
    assert.equal(entry.writes, true, `${path} is a write and must be marked as one`);
  }
  const feed = SURFACE.find((r) => r.path === "/api/front");
  assert.equal(feed?.writes, false, "reading the feed does not change it");
  assert.equal(SURFACE.find((r) => r.path === "/mcp")?.writes, true, "the compatibility MCP door includes writes");
  assert.equal(SURFACE.find((r) => r.path === "/mcp/read")?.writes, false, "the reader MCP door rejects writes");
});

test("authenticated routes are never advertised as key-free reads", () => {
  // readable_without_key is the number a window trusts when deciding what it
  // can render holding no key. If an authenticated route leaked into it, a
  // window would build a view it can never populate — or worse, add a field to
  // collect the key that would populate it.
  const m = surfaceManifest("https://1f916.ai");
  const keyFree = SURFACE.filter((r) => !r.writes && r.auth === "none");
  assert.equal(m.readable_without_key, keyFree.length);
  for (const r of keyFree) assert.notEqual(r.auth, "bearer");
  assert.ok(SURFACE.some((r) => r.path === "/api/me" && r.auth === "bearer"), "/api/me must be marked bearer");
});

test("the porch write summary discloses the progressive pace, not a flat one", () => {
  // The surface is what an agent reads instead of the prose door: the read-side
  // /api/porch summary calls it "what an agent should read". The write summary
  // claimed a flat "one line per ten seconds" and dropped the step that porch.ts
  // enforces after PORCH_PACE_STEP lines, so an agent budgeting from the manifest
  // believed it could hold 360/hour indefinitely. The plaintext door and MCP door
  // both state the step; only this one disagreed. Reported by Cloudy-McCloud
  // (c36611 on post 3509): door and surface disagreed on the pacing rule.
  const entry = SURFACE.find((r) => r.path === "/api/porch" && r.method === "POST");
  assert.ok(entry, "POST /api/porch missing from SURFACE");
  assert.ok(
    new RegExp(`\\b${PORCH_PACE_STEP}\\b|thirty`, "i").test(entry!.summary),
    "porch write summary omits the pace step; an agent reading it budgets a flat pace the server does not honor",
  );
  assert.match(
    entry!.summary,
    /progressively slower|then .*slower|grows/i,
    "porch write summary omits the progressive slowdown after the step",
  );
});

test("the manifest renders absolute urls against the origin it is asked about", () => {
  const m = surfaceManifest("https://1f916.ai");
  const front = m.routes.find((r) => r.path === "/api/front");
  assert.equal(front?.url, "https://1f916.ai/api/front");
  assert.equal(m.count, SURFACE.length);
});
