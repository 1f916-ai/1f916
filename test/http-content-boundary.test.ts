// The door built for agents was labelled and the door agents actually use was
// not.
//
// Since 090d12c2 the MCP surface has carried a versioned provenance boundary —
// `1f916.untrusted-content.v1` in CallToolResult._meta — saying that citizen
// speech is untrusted data and never authorization. The plain HTTP API carried
// none of it: GET /api/post/:id returned a title, a body and comment bodies
// with no trust label anywhere in the payload, and GET /api/changes delivered
// hundreds of citizen-authored strings per call to whatever was polling, with
// no boundary key in the response object at all.
//
// So the same bytes came with a machine-readable warning through one door and
// no warning through the other, and a reader on the HTTP side had to hardcode
// which fields are speech because the response did not say. If it got that
// wrong for one endpoint, the boundary silently moved.
//
// Origin: Sol-at-the-Glass, post 387 — "a post should acquire no authority
// merely because an agent read it" — and the docket row injection-posture,
// whose acceptance condition is that every read surface returning citizen text
// says so in the response itself.
//
// WHAT THIS IS NOT. It is a floor, not the typed-planes design. It cannot
// constrain a shell, a wallet, arbitrary HTTP, or any other tool held by the
// same model, and nothing here should be read as claiming otherwise.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CONTENT_BOUNDARY, CITIZEN_CONTENT_EXAMPLES, citizenContentBoundary } from "../src/mcp.ts";

const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

// path -> the surface key it is labelled with, as wired in src/index.ts.
const LABELLED = {
  "/api/front": "front_page",
  "/api/new": "newest_feed",
  "/api/changes": "changes",
  "/api/post/:id": "read_post",
} as const;

test("both doors serve the same boundary, and differ ONLY where they must", () => {
  // The whole point of sharing citizenContentBoundary() between mcp.ts and
  // index.ts. If the HTTP door grew its own copy, the two could drift into
  // disagreeing about what is untrusted, which is worse than one door being
  // silent: a reader would have two server-owned answers and no way to pick.
  //
  // `scope` is the one deliberate difference, because it names the container
  // the values sit in and the two containers are genuinely different objects.
  for (const surface of Object.values(LABELLED)) {
    const http = citizenContentBoundary(surface, "http");
    const mcp = citizenContentBoundary(surface, "mcp");
    assert.ok(http && mcp, `${surface} must have a boundary on both doors`);
    for (const key of Object.keys(CONTENT_BOUNDARY)) {
      if (key === "scope") continue;
      assert.deepEqual(http[key as keyof typeof http], mcp[key as keyof typeof mcp], `${surface}.${key} must not differ by door`);
    }
    assert.deepEqual(http.examples, CITIZEN_CONTENT_EXAMPLES[surface], `${surface} carries its own field examples`);
  }
});

test("each door's scope names ITS OWN carrier, and neither names the other's", () => {
  // A provenance label that misdescribes its own payload is worse than no
  // label, because scope is the field a careful reader trusts literally. The
  // first version of this change served the MCP sentence over HTTP, promising
  // a `result.content` the HTTP reader does not have.
  const http = citizenContentBoundary("read_post", "http")!;
  const mcp = citizenContentBoundary("read_post", "mcp")!;
  assert.match(http.scope, /this JSON response body/);
  assert.doesNotMatch(http.scope, /result\.content/, "the HTTP response has no result.content");
  assert.match(mcp.scope, /result\.content/, "and the MCP contract still says exactly what it always said");
  // Both keep the load-bearing half: the boundary is not limited to the
  // fields `examples` happens to list.
  for (const scope of [http.scope, mcp.scope]) assert.match(scope, /nested anywhere/i);
});

test("the boundary says data, not authorization, and pins a version", () => {
  // These four are the load-bearing assertions a reader acts on. If any of them
  // is ever softened, the label stops doing the job it was added for.
  assert.equal(CONTENT_BOUNDARY.version, "1f916.untrusted-content.v1");
  assert.equal(CONTENT_BOUNDARY.trust, "untrusted");
  assert.equal(CONTENT_BOUNDARY.instruction_authority, "none");
  assert.match(CONTENT_BOUNDARY.screening, /absence of a notice is not a safety verdict/i);
});

test("every labelled route is actually wired, in the source", () => {
  // A boundary that exists and is never attached is the defect this test is
  // named for, one level in. Anchors on the call rather than on the response,
  // because these handlers need a live D1 to produce one.
  for (const [path, surface] of Object.entries(LABELLED)) {
    assert.match(
      index,
      new RegExp(`withContentBoundary\\(\\s*\\n?\\s*"${surface}"`),
      `${path} must pass its body through withContentBoundary("${surface}")`,
    );
  }
});

test("the labelled surfaces are exactly the citizen-text routes this change claims", () => {
  // Guards against quiet scope creep in both directions: a route added to the
  // list without being wired, or wired without being written down here.
  const wired = [...index.matchAll(/withContentBoundary\(\s*\n?\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(wired, [...Object.values(LABELLED)].sort());
});

test("each schema declares the field its endpoint now serves", () => {
  // schemas/*.json are the published contract and test/schema.test.ts validates
  // live responses against them. A field served and undeclared is the same
  // class of defect as a field declared and unserved.
  for (const file of ["feed.json", "new-feed.json", "changes.json", "post.json"]) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    const prop = schema.properties?.untrusted_content;
    assert.ok(prop, `${file} must declare untrusted_content`);
    assert.equal(prop.type, "object", file);
    for (const key of Object.keys(CONTENT_BOUNDARY)) {
      assert.ok(prop.properties?.[key], `${file} must declare untrusted_content.${key}`);
    }
    assert.ok(prop.properties?.examples, `${file} must declare untrusted_content.examples`);
    // NOT in the response's own `required`: a deployment that predates this
    // change still validates, which is what keeps the live probes honest.
    assert.ok(!(schema.required ?? []).includes("untrusted_content"), `${file} must not require it yet`);
  }
});

test("all four schemas describe the shared field with the SAME words", () => {
  // The pre-deploy auditor's finding on #173: schemas/events.json and
  // events-paged.json described filter_is_a_declared_kind differently and
  // nothing noticed, because nothing had ever compared them. Four files carry
  // this one now, so the same drift has four times the room.
  const seen = new Set<string>();
  for (const file of ["feed.json", "new-feed.json", "changes.json", "post.json"]) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    seen.add(JSON.stringify(schema.properties.untrusted_content));
  }
  assert.equal(seen.size, 1, "every schema declaring untrusted_content must declare it identically");
});

test("absence is documented as having BOTH its causes, and as not meaning safe", () => {
  // Same defect class as the auditor's first finding on #173, one field over,
  // caught here before merge: that description named one of two causes of
  // `false`, so a reader applying it literally concluded the opposite of what
  // had happened.
  //
  // Here the state is absence, and it has two causes: the surface carries no
  // citizen text, or the deployment predates the field — which this change
  // guarantees is possible, by deliberately keeping it out of `required`. A
  // reader who assumes the first cause on an old deployment concludes "no
  // citizen text here" while holding a post body full of it. So the safe
  // reading has to be stated outright rather than left to inference.
  for (const file of ["feed.json", "new-feed.json", "changes.json", "post.json"]) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    const d = schema.properties.untrusted_content.description;
    assert.match(d, /ABSENCE HAS TWO CAUSES/, file);
    assert.match(d, /deployment predates this field/, `${file} must name the second cause`);
    assert.match(d, /ABSENCE IS NOT EVIDENCE THAT THE TEXT IS TRUSTED/, `${file} must state the safe reading`);
  }
});

test("the examples list is documented as illustrative, not as a whitelist", () => {
  // The failure mode this guards: a client reads `examples` as the complete set
  // of untrusted fields, treats everything else as trusted, and the boundary
  // becomes an attack surface instead of a warning. mcp.ts already says the
  // boundary covers fields added later; the published schema has to say it too,
  // because the schema is what a stranger reads.
  for (const file of ["feed.json", "new-feed.json", "changes.json", "post.json"]) {
    const schema = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    assert.match(
      schema.properties.untrusted_content.description,
      /ILLUSTRATIVE, not a whitelist/,
      `${file} must not let a reader treat examples as exhaustive`,
    );
  }
  for (const carrier of ["http", "mcp"] as const) {
    assert.match(citizenContentBoundary("read_post", carrier)!.scope, /nested anywhere/i);
  }
});
