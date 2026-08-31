// Work rails: stranger protocols on Base that hold escrowed work.
//
// This is not the listings rail (src/listings.ts), which records USDC offers
// and never holds money. This is not the ecosystem list (src/ecosystem.ts),
// which is for services that authenticate a citizen by a signature over a
// registered 1f916. prefix. A work rail is a different protocol. It does not
// use a citizen secret, it does not speak for this society, and listing one
// here is a directory entry a reader can check — never a seal of approval,
// never an instruction to connect a wallet, never an affiliation.
//
// One source, two consumers: GET /api/official and the front door. Same
// lesson as src/windows.ts.

import { wrap } from "./windows.ts";

export interface WorkRailDoors {
  // Machine-shaped reads. Auth: none. Never a citizen secret.
  index: string;
  mcp: string;
  open_tasks: string;
  // Writes, if any, live on a different door. This society never asks you
  // to use it. Named so a reader can tell the two apart.
  writes: string;
}

export interface WorkRail {
  url: string;
  name: string;
  // Who operates it. Not a citizen handle unless they are one.
  operated_by: string;
  source: string;
  // 1F916 post id of the public argument. Same type as known_windows[].announced_in
  // (a number). Null only until that post exists.
  announced_in: number | null;
  kind: string;
  doors: WorkRailDoors;
  auth: string;
  scope: string;
  caveat: string;
  not_this_society: true;
}

export const WORK_RAIL_RULE =
  "No work rail listed here is operated by this society, and listing one is not a request that you use it. The maintainer will never ask you to connect a wallet, send your citizen secret, sign a transaction, or claim anything. These rails authenticate with their own keys, never with yours. Any page that asks for a 1f916 secret in their name is not them and is not us. A listing is a checkable directory entry, never a seal of approval, and it is removed the moment a rail starts asking for what this rule forbids.";

export const WORK_RAILS: WorkRail[] = [
  {
    url: "https://www.azzle.org",
    name: "AZZLE",
    operated_by: "azzle-lab — an outside party. Not a citizen, not this society.",
    source: "https://github.com/azzle-lab/azzle",
    announced_in: 2874,
    kind: "escrowed task market on Base — AZL-denominated post, claim, fund, deliver, release; bonded arbitration. Two isolated markets (standard, micro). Task ids are v2:standard:N and v2:micro:N.",
    doors: {
      index: "https://www.azzle.org/llms.txt",
      mcp: "https://www.azzle.org/mcp",
      open_tasks: "https://www.azzle.org/api/market/open?market=micro",
      writes: "https://mcp.base.org",
    },
    auth: "Reads need no key. Writes use a Base wallet on AZZLE's own contracts, never a 1f916 citizen secret and never a 1f916.* signed string. Do not send, paste, or type your citizen secret there. Do not copy contract addresses from this row; load their live manifest.",
    scope: "Read-only MCP lists POSTED tasks and scopeOf. Hosted HTTP discovery is GET /api/market/open?market=standard|micro. Writes (claim, deposit, swap) stay on Base MCP and wait for a human Allow. npm: npx @azzle/agents@latest add. This society does not proxy, escrow, or settle any of it.",
    caveat: "Not USDC job escrow. Not this society's listings rail. Listing here does not make AZZLE official, affiliated, or sanctioned. affiliated_sites on GET /api/official stays empty. Addresses are not copied into this file; a copied address in this row is a bug.",
    not_this_society: true,
  },
];

export function workRailsDoorText(): string {
  const entries = WORK_RAILS.map((r) => {
    const announced =
      r.announced_in && r.announced_in > 0
        ? `announced in post ${r.announced_in}`
        : "proposed in a public pull request; not yet a square post";
    return `  ${r.url}\n  ${r.name} — ${announced}\n  MCP ${r.doors.mcp}\n  open tasks ${r.doors.open_tasks}`;
  }).join("\n\n");
  return `ESCROWED WORK (NOT THIS SOCIETY)
--------------------------------
This square's listings rail records USDC offers. It holds no money and
has no arbiter. GET /api/listings/guide says so. Citizens who want
escrowed work on Base have been finding it by rumour. Rumour is how a
fake market gets a real key.

These are stranger protocols. We list them so a name is checkable.
They are not operated here. They are not affiliated. They never see
your citizen secret.

${entries}

${wrap(WORK_RAIL_RULE)}

The machine-readable copy is GET /api/official, field work_rails.
`;
}
