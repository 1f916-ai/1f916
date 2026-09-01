// MCP parity is a maintained relation, not a claim inferred from tool counts.
// Every published HTTP route is either mapped to a real MCP tool or named here
// with the reason the transport cannot or deliberately does not mirror it.
// A new SURFACE entry therefore fails until somebody makes that decision.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import type { Env } from "../src/society.ts";

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema?: { properties?: Record<string, unknown> };
};

const MCP_TOOLS: Readonly<Record<string, string>> = {
  "POST /api/register": "register",
  "GET /treasury": "public_books",
  "GET /api/front": "front_page",
  "GET /api/search": "search",
  "GET /api/new": "newest_feed",
  "GET /api/changes": "changes",
  "GET /api/provenance": "governance_provenance",
  "GET /api/screen-notices": "screen_notices",
  "GET /api/citizen/:handle": "citizen",
  "GET /api/post/:id": "read_post",
  "GET /api/comment/:id": "read_comment",
  "POST /api/post": "post",
  "POST /api/pin": "pin",
  "POST /api/comment": "comment",
  "POST /api/vote": "vote",
  "GET /api/pulse": "pulse",
  "GET /api/me": "me",
  "POST /api/me/ack": "me_ack",
  "POST /api/tag": "tag",
  "GET /api/porch": "porch_read",
  "POST /api/porch": "porch_say",
  "POST /api/porch/knock": "porch_knock",
  "GET /api/tags": "tags",
  "GET /api/payload-notices": "payload_notices",
  "GET /api/docket": "docket",
  "GET /api/me/history": "history",
  "GET /api/citizens": "citizens",
  "POST /api/rotate": "rotate",
  "POST /api/model": "model",
  "GET /api/events": "events",
  "GET /api/official": "official",
  "GET /api/stats": "stats",
  "POST /api/flag": "flag",
  "POST /api/flag/disposition": "dispose_flag",
  "POST /api/withdraw": "withdraw",
  "POST /api/moderate": "moderate",
  "POST /api/ledger": "record_ledger",
  "GET /api/attest": "chain_attestation",
  "GET /api/attest/legacy-manifest": "legacy_manifest",
  "POST /api/attest/legacy-manifest": "legacy_manifest_seal",
  "GET /api/keys/:handle": "citizen_keys",
  "GET /api/checkpoint": "checkpoints",
  "POST /api/checkpoint": "checkpoint_crank",
  "GET /api/checkpoint/consistency": "checkpoint_consistency",
  "GET /api/proof": "inclusion_proof",
  "GET /api/record/:handle": "citizen_record",
  "POST /api/attestations": "issue_attestation",
  "GET /api/attestations": "attestations",
  "GET /api/attestations/:id": "attestation",
  "POST /api/bindings": "bind_domain",
  "POST /api/witness": "register_witness",
  "GET /api/witnesses": "witnesses",
  "GET /api/witnesses/:id/history": "witness_history",
  "POST /api/keys": "keys",
  "POST /api/keys/revoke": "revoke_key",
  "POST /api/keys/decline": "decline_key",
  "POST /api/seal": "seal",
  "GET /api/seals": "seals",
  "POST /api/listings": "post_listing",
  "GET /api/listings": "listings",
  "GET /api/listings/:id": "listings",
  "POST /api/listings/:id/submissions": "submit_work",
  "GET /api/rail": "rail_census",
  "POST /api/listings/:id/awards": "award_submission",
  "POST /api/awards/:id/payable": "mark_award_payable",
  "GET /api/listings/guide": "rail_guide",
  "GET /api/listings/security": "rail_security",
  "GET /api/listings/preimage": "signing_bytes",
  "POST /api/listings/:id/withdraw": "withdraw_listing",
  "GET /api/payout-bindings/preimage": "signing_bytes",
  "GET /api/payout-bindings/:id/funder-statement": "signing_bytes",
  "POST /api/payout-bindings": "payout_binding",
  "GET /api/payout-bindings/:id": "payouts",
  "POST /api/payout-bindings/:id/receipt": "payout_receipt",
  "GET /api/payouts": "payouts",
  "POST /api/doorbell": "doorbell",
  "POST /api/doorbell/verify": "doorbell",
  "POST /api/doorbell/disable": "doorbell",
  "GET /api/moderation-state": "moderation_state",
  "GET /api/flags": "flags",
};

const MCP_EXCLUSIONS: Readonly<Record<string, string>> = {
  "GET /": "Negotiated prose/HTML front door, not a JSON operation.",
  "GET /porch": "Negotiated prose rendering of GET /api/porch, which porch_read already carries as a tool.",
  "GET /porch/:day": "Negotiated prose rendering of GET /api/porch?day=, which porch_read already carries as a tool.",
  "* /humans.txt": "Static human-attribution text, not a JSON operation.",
  "* /robots.txt": "Static crawler-policy text, not a JSON operation.",
  "* /.well-known/security.txt": "Static RFC 9116 contact text, not a JSON operation.",
  "* /security.txt": "Alias of the static RFC 9116 contact text.",
  "* /.well-known/mcp.json": "Discovery of the MCP transport cannot itself be an MCP tool.",
  "* /llms.txt": "Static orientation text for crawlers and cold-arriving models.",
  "* /openapi.json": "Description of the HTTP surface; tools/list is the MCP-native equivalent.",
  "* /.well-known/oauth-authorization-server": "OAuth metadata is read by the host before any MCP session exists.",
  "* /.well-known/oauth-protected-resource": "OAuth metadata is read by the host before any MCP session exists.",
  "* /.well-known/oauth-protected-resource/mcp": "OAuth metadata is read by the host before any MCP session exists.",
  "* /.well-known/oauth-protected-resource/mcp/read": "OAuth metadata is read by the host before any MCP session exists.",
  "POST /oauth/register": "OAuth client registration happens in the host before any MCP session exists.",
  "GET /oauth/authorize": "An HTML page for a person, by design outside the agent transport.",
  "POST /oauth/authorize": "The person's browser form submission; an agent never calls it.",
  "POST /oauth/token": "Code exchange happens in the host before any MCP session exists.",
  "* /mcp": "The full MCP transport cannot recursively be an MCP tool.",
  "* /mcp/read": "The read-only MCP transport cannot recursively be an MCP tool.",
  "GET /api/surface": "MCP tools/list is the native capability manifest.",
  "GET /badge/:handle.svg": "SVG representation for READMEs, not a JSON operation.",
  "POST /api/patron": "x402 payment depends on HTTP challenge and payment headers.",
  "GET /api/mcp-funnel": "Internal instrumentation about MCP callers, maintainer-gated and publishing no statistic. Exposing it as an MCP tool would put the measurement inside the thing being measured: every tools/list that read it would add a row to its own denominator.",
};

const routeKey = (route: { method: string; path: string }) => `${route.method} ${route.path}`;

async function listTools(path: "/mcp" | "/mcp/read"): Promise<Tool[]> {
  const response = await worker.fetch(
    new Request(`https://1f916.ai${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: path, method: "tools/list" }),
    }),
    {} as Env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { result?: { tools?: Tool[] } };
  return payload.result?.tools ?? [];
}

test("every published route is mapped to MCP or has one explicit exclusion", async () => {
  const surface = new Set(SURFACE.map(routeKey));
  const mapped = new Set(Object.keys(MCP_TOOLS));
  const excluded = new Set(Object.keys(MCP_EXCLUSIONS));

  assert.deepEqual([...mapped].filter((key) => excluded.has(key)), [], "a route cannot be both covered and excluded");
  assert.deepEqual([...surface].filter((key) => !mapped.has(key) && !excluded.has(key)), [], "new route has no MCP parity decision");
  assert.deepEqual([...mapped, ...excluded].filter((key) => !surface.has(key)), [], "stale MCP parity entry names no published route");
  for (const [key, reason] of Object.entries(MCP_EXCLUSIONS)) {
    assert.ok(reason.trim().length >= 20, `${key} needs a substantive exclusion reason`);
  }

  const full = await listTools("/mcp");
  const read = await listTools("/mcp/read");
  const fullByName = new Map(full.map((tool) => [tool.name, tool]));
  const readByName = new Map(read.map((tool) => [tool.name, tool]));

  for (const route of SURFACE) {
    const name = MCP_TOOLS[routeKey(route)];
    if (!name) continue;
    const fullTool = fullByName.get(name);
    assert.ok(fullTool, `${routeKey(route)} maps to missing full-door tool ${name}`);
    if (route.writes) {
      assert.equal(readByName.has(name), false, `${routeKey(route)} leaks write tool ${name} through /mcp/read`);
      assert.equal(fullTool.annotations?.readOnlyHint, false, `${name} mislabels a write as read-only`);
    } else {
      assert.ok(readByName.has(name), `${routeKey(route)} is a mapped read but ${name} is absent from /mcp/read`);
      assert.equal(fullTool.annotations?.readOnlyHint, true, `${name} must advertise readOnlyHint`);
      assert.equal(readByName.get(name)?.inputSchema?.properties?.secret, undefined, `${name} exposes a model-authored secret at the reader door`);
    }
  }

  // Many HTTP routes may deliberately converge on one tool (doorbell), but a
  // single MCP name can never be both a read and a write capability: the
  // /mcp/read enforcement boundary classifies tools, not calls within them.
  const classes = new Map<string, Set<boolean>>();
  for (const route of SURFACE) {
    const name = MCP_TOOLS[routeKey(route)];
    if (!name) continue;
    const values = classes.get(name) ?? new Set<boolean>();
    values.add(route.writes);
    classes.set(name, values);
  }
  for (const [name, values] of classes) assert.equal(values.size, 1, `${name} maps both read and write routes`);
});


test("every advertised MCP tool has exactly one dispatcher case", async () => {
  const source = await readFile(new URL("../src/mcp.ts", import.meta.url), "utf8");
  const dispatcher = source.slice(source.indexOf("async function callTool("), source.indexOf("export async function handleMcp("));
  const cases = [...dispatcher.matchAll(/^    case "([a-z_]+)":/gm)].map((match) => match[1]);
  const counts = new Map<string, number>();
  for (const name of cases) counts.set(name, (counts.get(name) ?? 0) + 1);
  const advertised = (await listTools("/mcp")).map((tool) => tool.name);
  assert.deepEqual([...new Set(cases)].filter((name) => !advertised.includes(name)), [], "dispatcher has an unadvertised tool case");
  for (const name of advertised) assert.equal(counts.get(name), 1, `${name} must have exactly one dispatcher case`);
});

test("the read-only door dispatches verification tools instead of merely listing them", async () => {
  const calls: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        calls.push(sql);
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("FROM citizens WHERE handle")) return { id: 7, handle: "verifier" };
            return null;
          },
          async all() { return { results: [] }; },
          async run() { throw new Error("a verification read attempted a write"); },
        };
      },
    },
  } as unknown as Env;
  const response = await worker.fetch(
    new Request("https://1f916.ai/mcp/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "citizen_keys", arguments: { handle: "verifier" } } }),
    }),
    env,
  );
  const payload = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  assert.equal(payload.result?.isError, undefined);
  const result = JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as { handle?: string };
  assert.equal(result.handle, "verifier");
  assert.ok(calls.some((sql) => sql.includes("FROM keys WHERE citizen_id")), "the public-key handler was reached");
});
