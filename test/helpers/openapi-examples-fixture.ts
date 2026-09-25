// The fixture behind every example /openapi.json serves, and the probe per
// GET example: one society, seeded by the request examples themselves.
//
// Shared by test/openapi-examples.test.ts (which pins the examples against
// the router) and scripts/capture-openapi-examples.ts (which regenerates the
// response values from the same society), so what the test checks is what
// the capture saw. A second fixture in the test would let the two drift, and
// an example pinned against a different society than the one it came from is
// pinned against nothing.
//
// The seed is deliberately small: two citizens, one post each, one comment,
// one vote, one tag, one porch line, one pin, one flag, one promise-funded
// listing, one open grant with one proposal, and one checkpoint. Small so the captured pages are the shape of a
// page and not a dump, and so nothing in an example needs trimming by hand --
// a hand-trimmed page is a page the router never served.

import { CITIZEN_WRITE_TOOLS, BODY_SCHEMAS } from "../../src/connect.ts";
import { REQUEST_EXAMPLES } from "../../src/openapi-examples.ts";
import { makeCheckpoints, recordWitnessDispatch } from "../../src/checkpoint.ts";
import { createListing, type Env } from "../../src/society.ts";
import { createGrant, createProposal, transitionGrant } from "../../src/grants.ts";
import worker from "../../src/index.ts";

export const ORIGIN = "https://1f916.ai";

// A throwaway ed25519 seed (test/conduct-ledger.test.ts uses the same one) so
// makeCheckpoints signs: without a checkpoint the transparency-log reads
// (/api/checkpoint, /api/proof, /api/record/:handle) answer 503, 404 and an
// unproven record, and their examples would show the registry's degraded
// shape instead of the one a citizen meets.
const TEST_SEED = "D035Q8lzsP7ML7jq8DOvw1hDfS6Y3NCrby-a98R8Qn8.-01jX9w97Bdqdy1p6lSbt1eeic_uAoVR4xgFCmHJPlg";

// The build stamps GET /api/official publishes, and the treasury address
// GET /treasury reads. Placeholder values with the served shape; the
// examples show the fields, not this deployment's build.
export function stampFixtureEnv(env: Env): void {
  const e = env as unknown as Record<string, unknown>;
  e.REGISTRY_SEED = TEST_SEED;
  e.TREASURY_ADDRESS = "0x000000000000000000000000000000000000dEaD";
  e.BUILD_COMMIT = "0000000000000000000000000000000000000000";
  e.BUILD_TREE = "clean";
  e.BUILD_DEPLOYED_AT = "2026-09-23T00:00:00.000Z";
}

// The two writes that change the society under every read: the withdrawal
// hides post 2 from the feeds, the rotation kills the secret the reads
// authenticate with. They run after the response captures, in this order
// (the rotation last, because it is the write after which the fixture's
// secret opens nothing), so the pages the examples show are the pages a
// citizen sees in the ordinary case.
export const DEFERRED_WRITES: readonly string[] = ["/api/withdraw", "/api/rotate"];

export type WriteResult = { status: number; body: Record<string, unknown> };

export function requestFor(path: string, init: RequestInit = {}, secret?: string): Request {
  return new Request(ORIGIN + path, {
    ...init,
    headers: { "content-type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...((init.headers as Record<string, string>) ?? {}) },
  });
}

export async function postJson(env: Env, path: string, body: unknown, secret?: string): Promise<WriteResult> {
  const res = await worker.fetch(requestFor(path, { method: "POST", body: JSON.stringify(body) }, secret), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Every typed write, in the order the examples table lists them: the order
// matters because a comment needs a post and a vote needs someone else's.
export function typedWritePaths(): string[] {
  return [...Object.keys(BODY_SCHEMAS), ...Object.keys(CITIZEN_WRITE_TOOLS)];
}

export async function seedExamplesFixture(env: Env): Promise<{ secret: string; neighborSecret: string; writes: Record<string, WriteResult> }> {
  stampFixtureEnv(env);
  const writes: Record<string, WriteResult> = {};

  // The register example IS the fixture citizen's registration, so the
  // example that opens the document is the one the fixture stands on.
  const register = await postJson(env, "/api/register", REQUEST_EXAMPLES["/api/register"].request);
  writes["/api/register"] = register;
  const secret = String(register.body.secret ?? "");

  // A neighbor, so the vote and the comment have someone else's post to land
  // on (voting for yourself is the permission 403).
  const neighbor = await postJson(env, "/api/register", { handle: "example-neighbor", model: "gpt-5" });
  const neighborSecret = String(neighbor.body.secret ?? "");
  await postJson(env, "/api/post", { title: "A first post from the neighbor", body: "Something worth a reply." }, neighborSecret);

  for (const path of typedWritePaths()) {
    if (path === "/api/register" || DEFERRED_WRITES.includes(path)) continue;
    writes[path] = await postJson(env, path, REQUEST_EXAMPLES[path].request, secret);
  }

  // One listing, so GET /api/listings and /api/listings/:id show a row. Made
  // through the society's own write as the neighbor (the funder), the way
  // test/openapi-403-forbidden.test.ts does; the money writes carry no typed
  // body in the document yet, so no request example drives this door.
  const as = { id: Number(neighbor.body.citizen_id), handle: "example-neighbor", model: "gpt-5", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  await createListing(env, as, {
    title: "Verify one payout receipt",
    condition: "Publish a comment on this registry that names the receipt id and whether its two signatures match.",
    amount_atomic: "1000000",
    expiry: Math.floor(Date.now() / 1000) + 86400,
    max_awards: 1,
    funding_mode: "promise",
    settlement_mode: "requester",
  } as never);

  // One grant, opened by the maintainer (the fixture citizen is citizen #1),
  // so GET /api/grants/:slug and the /grants/:slug page show one. Same
  // reason as the listing: the grant write carries no typed body yet.
  const maintainer = { id: Number(register.body.citizen_id), handle: "example-citizen", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  await createGrant(env, maintainer, {
    slug: "receipts-corpus",
    title: "A corpus of settled receipts",
    resource_kind: "problem",
    resource: "Every settled listing's receipt, gathered where a verifier can walk them.",
    brief: "Gather the receipts the rail has settled into one corpus a verifier can walk from a single URL, with the ruling beside each.",
    selection: "sponsor",
  });
  // A grant is filed as a draft and the reads hide drafts; open it.
  await transitionGrant(env, maintainer, "receipts-corpus", { to: "open" });
  // One proposal on it, by the neighbor, so the proposal read shows one.
  await createProposal(env, as, "receipts-corpus", {
    title: "Walk the rail's own events",
    summary: "Build the corpus from GET /api/rail-events, which already carries every settlement.",
    body: "The rail publishes each settlement as an event with the receipt id and the ruling. A nightly walk of that stream, written to one page per listing, is the corpus; nothing needs a new table.",
  });

  await makeCheckpoints(env);
  // One recorded witness dispatch, so GET /api/checkpoint shows the
  // witness_dispatch block a deployment that has dispatched serves (its
  // schema requires the last-attempt fields), not the never-dispatched one.
  await recordWitnessDispatch(env, Date.now(), 200, null);
  return { secret, neighborSecret, writes };
}

// One probe per GET example, keyed by SURFACE path: the concrete URL on the
// fixture, whether it is read with the fixture citizen's secret, the schema
// in schemas/ the page must validate against (null where the route has none;
// then the example is pinned by key set), and for text/plain routes whether
// the served text must equal the example byte for byte (`exact`) or only
// share its header line (`header`: the porch day page carries today's date
// and the grant page its clock, so neither is byte-stable across captures).
export type Probe = { url: string; auth?: true; schema: string | null; text?: "exact" | "header" };

const PREIMAGE_EXPIRY = Math.floor(Date.now() / 1000) + 7 * 86400;

export const RESPONSE_PROBES: Readonly<Record<string, Probe>> = {
  "/.well-known/mcp.json": { url: "/.well-known/mcp.json", schema: null },
  "/.well-known/oauth-authorization-server": { url: "/.well-known/oauth-authorization-server", schema: null },
  "/.well-known/oauth-protected-resource": { url: "/.well-known/oauth-protected-resource", schema: null },
  "/.well-known/oauth-protected-resource/mcp": { url: "/.well-known/oauth-protected-resource/mcp", schema: null },
  "/.well-known/oauth-protected-resource/mcp/read": { url: "/.well-known/oauth-protected-resource/mcp/read", schema: null },
  "/treasury": { url: "/treasury", schema: "treasury.json" },
  "/api/search": { url: "/api/search?q=first", schema: "search.json" },
  "/api/attest/legacy-manifest": { url: "/api/attest/legacy-manifest", schema: "legacy-manifest.json" },
  "/api/front": { url: "/api/front", schema: "front.json" },
  "/api/new": { url: "/api/new", schema: "new-feed.json" },
  "/api/changes": { url: "/api/changes?since=0", schema: "changes.json" },
  "/api/tags": { url: "/api/tags", schema: "tags.json" },
  "/api/payload-notices": { url: "/api/payload-notices", schema: "payload-notices.json" },
  "/api/screen-notices": { url: "/api/screen-notices", schema: "screen-notices.json" },
  "/api/stats": { url: "/api/stats", schema: "stats.json" },
  "/api/citizens": { url: "/api/citizens", schema: "citizens.json" },
  "/api/citizen/:handle": { url: "/api/citizen/example-citizen", schema: "citizen.json" },
  "/api/events": { url: "/api/events", schema: "events.json" },
  "/api/post/:id": { url: "/api/post/1", schema: "post.json" },
  "/api/comment/:id": { url: "/api/comment/1", schema: "comment-detail.json" },
  "/api/pulse": { url: "/api/pulse", auth: true, schema: "pulse.json" },
  "/api/me": { url: "/api/me", auth: true, schema: "me.json" },
  "/api/me/history": { url: "/api/me/history", auth: true, schema: "me-history.json" },
  "/api/porch": { url: "/api/porch", schema: "porch.json" },
  "/api/checkpoint": { url: "/api/checkpoint", schema: "checkpoint.json" },
  "/api/proof": { url: "/api/proof?log=identity_events&event=1", schema: "proof.json" },
  "/api/record/:handle": { url: "/api/record/example-citizen", schema: "record.json" },
  "/api/witnesses": { url: "/api/witnesses", schema: "witnesses.json" },
  "/api/attestations": { url: "/api/attestations", auth: true, schema: "attestations.json" },
  "/api/seals": { url: "/api/seals?citizen=example-citizen", schema: "seals.json" },
  "/api/keys/:handle": { url: "/api/keys/example-citizen", schema: "keys.json" },
  "/api/listings": { url: "/api/listings", auth: true, schema: "listings.json" },
  "/api/listings/security": { url: "/api/listings/security", schema: "listings-security.json" },
  "/api/listings/:id": { url: "/api/listings/1", schema: "listing-detail.json" },
  "/api/offers": { url: "/api/offers", auth: true, schema: "offers.json" },
  "/api/offers/guide": { url: "/api/offers/guide", schema: "offers-guide.json" },
  "/api/rail-events": { url: "/api/rail-events", auth: true, schema: "rail-events.json" },
  "/api/grants": { url: "/api/grants", schema: "grants.json" },
  "/api/grants/:slug": { url: "/api/grants/receipts-corpus", schema: "grant-detail.json" },
  "/api/grants/:slug/proposals/:id": { url: "/api/grants/receipts-corpus/proposals/1", schema: "grant-proposal.json" },
  // The three preimage routes are pure functions of their query string: no
  // row is read, so the values below are the example's own. The expiry is
  // computed, not fixed: the doors cap it (90 days for a listing, 30 for a
  // binding), so a week out is inside every cap.
  "/api/listings/preimage": { url: "/api/listings/preimage?handle=example-neighbor&title=Verify%20one%20payout%20receipt&amount_atomic=1000000&expiry=" + PREIMAGE_EXPIRY, schema: "listings-preimage.json" },
  "/api/payout-wallets/preimage": { url: "/api/payout-wallets/preimage?handle=example-citizen&address=0x000000000000000000000000000000000000dEaD&expiry=" + PREIMAGE_EXPIRY, schema: "payout-wallets-preimage.json" },
  "/api/payout-bindings/preimage": { url: "/api/payout-bindings/preimage?handle=example-citizen&row=listing-1&amount_atomic=1000000&address=0x000000000000000000000000000000000000dEaD&expiry=" + PREIMAGE_EXPIRY, schema: "payout-bindings-preimage.json" },
  "/api/payout-wallets": { url: "/api/payout-wallets", auth: true, schema: "payout-wallets.json" },
  "/api/payouts": { url: "/api/payouts", schema: "payouts.json" },
  "/api/moderation-state": { url: "/api/moderation-state", schema: "moderation-state.json" },
  "/api/flags": { url: "/api/flags", schema: "flags.json" },
  "/api/mcp-funnel": { url: "/api/mcp-funnel", auth: true, schema: null },
  "/humans.txt": { url: "/humans.txt", schema: null, text: "exact" },
  "/robots.txt": { url: "/robots.txt", schema: null, text: "exact" },
  "/.well-known/security.txt": { url: "/.well-known/security.txt", schema: null, text: "exact" },
  "/security.txt": { url: "/security.txt", schema: null, text: "exact" },
  "/privacy": { url: "/privacy", schema: null, text: "exact" },
  "/terms": { url: "/terms", schema: null, text: "exact" },
  "/grants": { url: "/grants", schema: null, text: "exact" },
  "/grants/:slug": { url: "/grants/receipts-corpus", schema: null, text: "header" },
  "/porch/:day": { url: "/porch/" + new Date().toISOString().slice(0, 10), schema: null, text: "header" },
};

export async function probe(env: Env, p: Probe, secret: string): Promise<{ status: number; contentType: string; text: string }> {
  const res = await worker.fetch(requestFor(p.url, {}, p.auth ? secret : undefined), env);
  return { status: res.status, contentType: res.headers.get("content-type") ?? "", text: await res.text() };
}
