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
// listing, one open grant with one proposal, one offer, one attestation,
// and one checkpoint. Small so the captured pages are the shape of a
// page and not a dump, and so nothing in an example needs trimming by hand --
// a hand-trimmed page is a page the router never served.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { CITIZEN_WRITE_TOOLS, BODY_SCHEMAS } from "../../src/connect.ts";
import { REQUEST_EXAMPLES } from "../../src/openapi-examples.ts";
import { makeCheckpoints } from "../../src/checkpoint.ts";
import { jwkThumbprint } from "../../src/keys.ts";
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
  // The one KV binding stored memories are written to (POST /api/memory).
  // In memory, like the database: the bytes die with the fixture.
  const kv = new Map<string, Uint8Array | string>();
  e.RECORDS = {
    put: async (k: string, v: Uint8Array | string) => void kv.set(k, v),
    get: async (k: string, type?: string) => {
      const v = kv.get(k);
      if (v === undefined) return null;
      if (type === "arrayBuffer") return (v instanceof Uint8Array ? v : new TextEncoder().encode(v)).slice().buffer;
      return typeof v === "string" ? v : new TextDecoder().decode(v);
    },
    delete: async (k: string) => void kv.delete(k),
  };
}

// Three throwaway Ed25519 keys, from fixed seeds so the signatures in the key
// examples are bytes a reader can verify and not a value regenerated on every
// run. Public test material, like TEST_SEED above: the keys sign nothing but
// the rotation example and bind nothing outside this in-memory database.
//   A: the key the citizen holds. Signs the rotation.
//   B: a second key, revoked by thumbprint.
//   C: the key the rotation hands over to.
//   D: the neighbor's key, which the neighbor's domain proof names.
// The thumbprints and the rotation signatures are written into the examples
// in src/openapi-examples.ts; the door verifying them is what keeps them honest.
const ED25519_PKCS8_PREFIX = "302e020100300506032b657004220420";
function publicKeyFromSeed(seedHex: string): string {
  const priv = createPrivateKey({ key: Buffer.from(ED25519_PKCS8_PREFIX + seedHex, "hex"), format: "der", type: "pkcs8" });
  return (createPublicKey(priv).export({ format: "jwk" }) as { x: string }).x;
}
const KEY_A_SEED = "11".repeat(32);
const KEY_B_SEED = "22".repeat(32);
const KEY_D_SEED = "44".repeat(32);

// The rotation example's signed_at. A dated signature is refused beyond ten
// minutes of the registry's clock, so the one rotation runs with the clock
// held at this instant (the key rows are bound a day before it). The
// signature in the example is over this value; a real client signs its own.
export const ROTATION_SIGNED_AT = Date.parse("2026-09-23T12:00:00.000Z");
export const EXAMPLE_DOMAIN = "agent.example.com";

// Run one write with the registry's clock held at `at`.
async function withClockAt<T>(at: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

// Run one write with fetch answering the domain-proof lookup the way a domain
// that published the TXT record would, and refusing every other request: no
// socket is opened, and an unplanned fetch is a test failure.
async function withDomainProof<T>(domain: string, handle: string, thumbprint: string, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === `https://cloudflare-dns.com/dns-query?name=_1f916.${domain}&type=TXT`)
      return Response.json({ Answer: [{ data: `"v=1; h=${handle}; k=${thumbprint}"` }] });
    throw new Error(`unplanned fetch in the examples fixture: ${url}`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
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

  // Declining a key is only possible while the citizen holds none, so it runs
  // before the two keys below are bound; everything that needs a key (the
  // doorbell, the domain binding, the revocation, the rotation) runs after.
  writes["/api/keys/decline"] = await postJson(env, "/api/keys/decline", REQUEST_EXAMPLES["/api/keys/decline"].request, secret);
  const citizenId = Number(register.body.citizen_id);
  const keyA = publicKeyFromSeed(KEY_A_SEED);
  const keyB = publicKeyFromSeed(KEY_B_SEED);
  const keyD = publicKeyFromSeed(KEY_D_SEED);
  const thumbprintD = await jwkThumbprint(keyD);
  for (const x of [keyA, keyB]) {
    await env.DB.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (?, 'Ed25519', ?, ?, 'self', 'active', ?)")
      .bind(citizenId, x, await jwkThumbprint(x), ROTATION_SIGNED_AT - 86_400_000)
      .run();
  }

  await env.DB.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (?, 'Ed25519', ?, ?, 'self', 'active', ?)")
    .bind(Number(neighbor.body.citizen_id), keyD, thumbprintD, ROTATION_SIGNED_AT - 86_400_000)
    .run();

  for (const path of typedWritePaths()) {
    if (path === "/api/register" || path === "/api/keys/decline" || DEFERRED_WRITES.includes(path)) continue;
    const send = () => postJson(env, path, REQUEST_EXAMPLES[path].request, secret);
    // The domain is bound by the neighbor, not the fixture citizen: GET
    // /api/record/:handle serves a domain binding under `bindings`, which
    // schemas/record.json describes as payout-key bindings ({id, x,
    // created_at}) -- a mismatch this fixture does not paper over by
    // putting a binding on the citizen whose record the probe reads.
    if (path === "/api/bindings")
      writes[path] = await withDomainProof(EXAMPLE_DOMAIN, "example-neighbor", thumbprintD, () => postJson(env, path, REQUEST_EXAMPLES[path].request, neighborSecret));
    else if (path === "/api/keys/rotate") writes[path] = await withClockAt(ROTATION_SIGNED_AT, send);
    else writes[path] = await send();
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

  // One offer, so GET /api/offers and /api/offers/:id show a row: the
  // neighbor selling, so the citizen reads someone else's price. Not a typed
  // write, so no request example drives this door.
  const offer = await postJson(env, "/api/offers", {
    title: "Check one payout receipt's two signatures",
    terms: "Send the receipt id. I verify both signatures against the published keys and reply in a comment with the result. One receipt per order.",
    amount_atomic: "500000",
    delivery_window_seconds: 86400,
    expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  }, neighborSecret);
  if (offer.status !== 201) throw new Error(`fixture offer answered ${offer.status}: ${String(offer.body.error ?? "")}`);
  // The attestation GET /api/attestations/:id shows is the one the typed
  // write above filed: a correction on the citizen's own record, the one
  // class that needs nobody else.
  await makeCheckpoints(env);
  // One recorded witness dispatch, so GET /api/checkpoint shows the
  // witness_dispatch block a deployment that has dispatched serves (its
  // schema requires the last-attempt fields), not the never-dispatched one.
  // The trigger that wrote this row was retired on 2026-09-29 and nothing in
  // src/ writes it now; the row is served as history, so it is inserted here
  // the way test/witness-dispatch-served.test.ts does.
  const dispatchedAt = Date.now();
  await env.DB.prepare(
    "INSERT INTO witness_dispatch (id, last_attempt_at, last_status, last_error, last_ok_at) VALUES (1, ?, 200, NULL, ?)",
  )
    .bind(dispatchedAt, dispatchedAt)
    .run();
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
  // Routes main added after the first capture (the anchors log, mandates, the
  // A2A card, the skills index, the APIs.json catalog): small pages the
  // fixture already serves with no extra seeding.
  "/api/anchors": { url: "/api/anchors", schema: "anchors.json" },
  // schema null: the fixture now holds mandates (the typed writes record
  // three), and the rows the router serves carry fields schemas/mandates.json
  // does not list (subject, signed, signature, key_thumbprint, signed_message,
  // envelope_format, has_outcome, outcome_added) under additionalProperties
  // false. That schema drift is not this file's to repair; the page is pinned
  // by key set until it is.
  "/api/mandates": { url: "/api/mandates", schema: null },
  "/.well-known/agent-card.json": { url: "/.well-known/agent-card.json", schema: null },
  "/skills/index.json": { url: "/skills/index.json", schema: null },
  "/apis.json": { url: "/apis.json", schema: null },
  // Routes main added after the second capture (the third MCP door's
  // resource metadata, the tools index, mandate budgets, stored memory, the
  // journal wake read, the signed checkpoint note, the support page), and
  // four older reads the fixture serves small: /about, the consistency proof,
  // one offer and one attestation.
  "/.well-known/oauth-protected-resource/mcp/protocol": { url: "/.well-known/oauth-protected-resource/mcp/protocol", schema: null },
  "/tools/index.json": { url: "/tools/index.json", schema: null },
  "/api/mandates/budgets": { url: "/api/mandates/budgets", schema: null },
  "/api/offers/:id": { url: "/api/offers/1", schema: "offer-detail.json" },
  "/api/memory": { url: "/api/memory?citizen=example-citizen", schema: null },
  "/api/journal": { url: "/api/journal", auth: true, schema: null },
  "/api/attestations/:id": { url: "/api/attestations/1", schema: null },
  // The fixture's one identity_events stamp, compared with itself: the only
  // pair one checkpoint run offers. Its size is the fixture's event count.
  "/api/checkpoint/consistency": { url: "/api/checkpoint/consistency?log=identity_events&from=20&to=20", schema: "checkpoint-consistency.json" },
  "/api/checkpoint/note/:log": { url: "/api/checkpoint/note/identity_events", schema: null, text: "header" },
  "/support": { url: "/support", schema: null, text: "exact" },
  "/about": { url: "/about", schema: null, text: "exact" },
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
