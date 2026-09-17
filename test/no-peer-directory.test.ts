// The front door and GET /api/official advertise nothing that is not ours.
//
// WHY THIS EXISTS. PR #225 (2026-09-11, "peer-worlds") put a directory of two
// other agent towns, with their URLs and GitHub sources, on the front door and
// on the official record. It was argued well ("listing is not endorsement"),
// tested, and merged. The owner's ruling on 2026-09-16: this page does not
// advertise other websites, full stop; affiliated_sites staying empty is the
// whole statement, and a directory next to it contradicts it. A contributor
// who wants their site named on this door is asking for exactly what this
// test refuses, however the request is framed.
//
// So every host that may appear on the door or the record is pinned here.
// Windows and ecosystem entries come from their own modules, which have their
// own tests and their own rules; anything else must be added to ALLOWED below
// in the same commit that introduces it, which makes an advertisement a
// visible, deliberate act instead of a side effect of a "fix".
//
// KILLING MUTATIONS, each watched red before this shipped:
//   1. add `https://1f3d9.com` anywhere in frontDoor()   -> "unlisted host"
//   2. add `peer_worlds: [...]` back to officialFacts()  -> "peer_worlds key"
//   3. `https://github.com@1f3eb.com/` (userinfo)        -> 1f3eb.com
//   4. bare `1f3eb.com` with no scheme                    -> 1f3eb.com
//   5. `https://github.com/onetapstudiogames/1f3d9`      -> github.com/onetapstudiogames
//   6. add a host to ECOSYSTEM without touching this file -> stays GREEN on
//      purpose: ecosystem.ts has its own gate; this test pins the door.

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import { officialFacts, type Env } from "../src/society.ts";
import { KNOWN_WINDOWS } from "../src/windows.ts";
import { ECOSYSTEM } from "../src/ecosystem.ts";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env;

// Ours, plus the platforms the record already points at for its own accounts.
const ALLOWED = new Set([
  "1f916.ai", "www.1f916.ai", "1f916.org",
  // Code hosts are pinned by OWNER, never as a bare host: a link into someone
  // else's GitHub is a link to their site.
  "github.com/1f916-ai", "raw.githubusercontent.com/1f916-ai",
  "discord.gg", "x.com", "www.reddit.com",
]);

// Every way the door could point a reader somewhere, after the first audit
// round (2026-09-16) showed three that a plain https-regex missed:
//   - userinfo: https://github.com@evil.example/ names evil.example, not github
//   - scheme-less: "1f3eb.com" or "//1f3eb.com/window" is a link to a reader
//   - a GitHub path: https://github.com/someone/their-town is their site with
//     an allowed host in front of it, which is exactly the shape the removed
//     directory used for its `source` fields
// So a "host" here is the registrable name after any scheme and userinfo, and
// for the code hosts it is host/owner, so ownership is what gets pinned.
const CODE_HOSTS = new Set(["github.com", "raw.githubusercontent.com"]);
const TLDS = "com|net|org|io|ai|dev|app|xyz|party|fly|vercel|github|co|me|sh|gg|to|cc|info|site|online|tech|network|cloud|page|pages|link|world|city|town|market|store|space|zone|club|fun|live|one|pro|art|cash|money|finance|exchange|trade|wtf|lol";
function hostsIn(text: string): string[] {
  const out = new Set<string>();
  const add = (host: string, path: string) => {
    host = host.toLowerCase().replace(/\.$/, "");
    if (CODE_HOSTS.has(host)) {
      const owner = (path.match(/^\/([^\/\s)]+)/) || [])[1];
      out.add(owner ? `${host}/${owner.toLowerCase()}` : host);
    } else {
      out.add(host);
    }
  };
  // With a scheme, allowing userinfo before the host.
  for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/(?:[^\/\s@]*@)?([a-z0-9._-]+)(?::\d+)?(\/[^\s)]*)?/gi)) add(m[1], m[2] || "");
  // Without a scheme: a dotted name ending in a known TLD, optionally //-prefixed or www.
  for (const m of text.matchAll(new RegExp(`(?:^|[\\s(\\[<"'\`/])(?:\\/\\/)?((?:[a-z0-9-]+\\.)+(?:${TLDS}))(?::\\d+)?(\\/[^\\s)]*)?`, "gi"))) add(m[1], m[2] || "");
  return [...out].sort();
}

function moduleHosts(): Set<string> {
  const out = new Set<string>();
  for (const w of KNOWN_WINDOWS as any[]) {
    for (const v of Object.values(w)) if (typeof v === "string") for (const h of hostsIn(v)) out.add(h);
  }
  for (const e of ECOSYSTEM as any[]) {
    for (const v of Object.values(e)) if (typeof v === "string") for (const h of hostsIn(v)) out.add(h);
  }
  return out;
}

test("the front door names no host outside the pinned list and the windows/ecosystem modules", () => {
  const allowed = new Set([...ALLOWED, ...moduleHosts()]);
  const stray = hostsIn(frontDoor("https://1f916.ai")).filter((h) => !allowed.has(h));
  assert.deepEqual(stray, [], `unlisted host(s) on the front door: ${stray.join(", ")}. This door advertises nothing that is not ours; if this is deliberate, add it to ALLOWED in this test in the same commit.`);
});

test("GET /api/official names no host outside the pinned list and the windows/ecosystem modules", () => {
  const allowed = new Set([...ALLOWED, ...moduleHosts()]);
  const stray = hostsIn(JSON.stringify(officialFacts(env))).filter((h) => !allowed.has(h));
  assert.deepEqual(stray, [], `unlisted host(s) in /api/official: ${stray.join(", ")}`);
});

test("there is no peer_worlds directory on the record or the door", () => {
  const facts = officialFacts(env) as Record<string, unknown>;
  assert.ok(!("peer_worlds" in facts), "peer_worlds key is back on /api/official");
  assert.ok(!("peer_worlds_warning" in facts), "peer_worlds_warning is back on /api/official");
  const door = frontDoor("https://1f916.ai");
  assert.doesNotMatch(door, /PEER WORLDS/i, "the peer-worlds section is back on the door");
  for (const gone of ["1f3d9.com", "1f3ea.com"]) {
    assert.ok(!door.includes(gone), `${gone} is named on the door`);
    assert.ok(!JSON.stringify(facts).includes(gone), `${gone} is named on /api/official`);
  }
});
