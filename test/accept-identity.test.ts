// GET /accept: accept a 1F916 identity (src/accept-identity.ts) and the
// reference check it names (clients/accept-identity.mjs).
//
// The page is instructions for someone who will never read our code, and the
// script is what they will run. A line on the page that the script does not
// build, a command the script does not have, or an example that does not
// verify sends them to a dead end they cannot diagnose. So each is held to the
// thing it names.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   A1  delete the /accept route                                   -> "the page is served as HTML"
//   A2  change the prefix in the page or in the script, not both   -> "the line on the page is the line the script builds"
//   A3  alter one character of the example's nonce or signature    -> "the worked example verifies against the key it names"
//   A4  rename a command on the page                               -> "the commands are the ones the script has"
//   A5  let the script count a revoked key                         -> "only an active key counts"
//   A6  drop the audience from the line the script builds          -> "a signature made for one audience fails at another"
//   A7  let the script's sign command sign a line it was handed    -> "the sign command builds the line itself"
//   A8  link an outside site, or a path the mirror does not serve  -> "the page names no site but this one"
//   A9  print the figure without its date                          -> "the figure carries the day it was read"
//   A10 return the handle as typed when the registry spells it otherwise (2026-10-06, auditor) -> "the handle that comes back is the registry's spelling"
//   A11 accept a non-canonical signature spelling, or a 22-hex nonce      -> "one spelling per signature, and a hex nonce is held to the hex length"
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  ACCEPT_ADOPT_PATH,
  ACCEPT_CHECK_COMMAND,
  ACCEPT_EXAMPLE,
  ACCEPT_EXAMPLE_COMMAND,
  ACCEPT_IDENTITY_HTML,
  ACCEPT_KEYS_BOUND,
  ACCEPT_KEYS_BOUND_DATE,
  ACCEPT_ORIGIN,
  ACCEPT_SCRIPT_PATH,
  ACCEPT_SCRIPT_REPO_PATH,
  ACCEPT_SIGN_COMMAND,
  IDENTITY_LINE,
  IDENTITY_MESSAGE_PREFIX,
} from "../src/accept-identity.ts";
import { SURFACE } from "../src/surface.ts";
import * as script from "../clients/accept-identity.mjs";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(ACCEPT_ORIGIN + path, { headers }), env as never);

const NONCE = "IVHgodbtPZCtekbcHZ1yfg";
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { x: (publicKey.export({ format: "jwk" }) as { x: string }).x, pem: privateKey.export({ type: "pkcs8", format: "pem" }) as string };
}

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/accept", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), ACCEPT_IDENTITY_HTML);
  assert.match(ACCEPT_IDENTITY_HTML, /<title>Accept a 1F916 identity · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/accept" && r.method === "GET"), "an agent reading the surface can find the page to hand a site");
});

test("the line on the page is the line the script builds", () => {
  assert.equal(script.IDENTITY_MESSAGE_PREFIX, IDENTITY_MESSAGE_PREFIX);
  assert.equal(IDENTITY_LINE, `${IDENTITY_MESSAGE_PREFIX}:<handle>:<audience>:<nonce>`);
  assert.equal(script.identityMessage("some-agent", "town.example", NONCE), `1f916.identity.v1:some-agent:town.example:${NONCE}`);
  assert.ok(ACCEPT_IDENTITY_HTML.includes(`<code id="line">${IDENTITY_LINE.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`), "the page shows the line whole, where the copy button reads it");
  // The surface says the same line, so a reader of either learns the same format.
  const entry = SURFACE.find((r) => r.path === "/accept")!;
  assert.ok(entry.summary.includes(IDENTITY_LINE));
  assert.ok(entry.summary.includes(ACCEPT_SCRIPT_PATH), "the surface names the path the mirror serves the script at");
  // No piece may carry a colon, or a site could move the boundaries of the line.
  for (const [h, a, n] of [["a:b", "x.y", NONCE], ["ab", "x.y:443", NONCE], ["ab", "x.y", `${NONCE}:x`], ["ab", "X.y", NONCE], ["ab", "https://x.y", NONCE], ["ab", "x.y", "short"]] as const) {
    assert.throws(() => script.identityMessage(h, a, n), /must/);
  }
});

test("the worked example verifies against the key it names", () => {
  const keys = [{ x: ACCEPT_EXAMPLE.public_key, thumbprint: ACCEPT_EXAMPLE.thumbprint, status: "active", bound_at: 1791326687806 }];
  const ok = script.verifyIdentity({ handle: ACCEPT_EXAMPLE.handle, audience: ACCEPT_EXAMPLE.audience, nonce: ACCEPT_EXAMPLE.nonce, signature: ACCEPT_EXAMPLE.signature, keys });
  assert.equal(ok.verified, true);
  assert.equal(ok.key.thumbprint, ACCEPT_EXAMPLE.thumbprint);
  assert.equal(ok.message, `${IDENTITY_MESSAGE_PREFIX}:${ACCEPT_EXAMPLE.handle}:${ACCEPT_EXAMPLE.audience}:${ACCEPT_EXAMPLE.nonce}`);
  // What the page says the example answers, and the command it shows, are this example.
  assert.equal(ACCEPT_EXAMPLE_COMMAND, `node accept-identity.mjs check ${ACCEPT_EXAMPLE.handle} ${ACCEPT_EXAMPLE.audience} ${ACCEPT_EXAMPLE.nonce} ${ACCEPT_EXAMPLE.signature}`);
  assert.ok(ACCEPT_IDENTITY_HTML.includes(`<code id="example">${ACCEPT_EXAMPLE_COMMAND}</code>`));
  assert.ok(ACCEPT_IDENTITY_HTML.includes(`Signed ${ACCEPT_EXAMPLE.bound_on} by the citizen <a href="/api/keys/${ACCEPT_EXAMPLE.handle}">${ACCEPT_EXAMPLE.handle}</a>`));
  assert.ok(ACCEPT_IDENTITY_HTML.includes(`a record running since ${ACCEPT_EXAMPLE.record_since}`));
  // The dates on the page are the ones the key and the citizen carry: bound 2026-10-06T22:44:47Z, registered 2026-08-28T19:01:09Z.
  assert.equal(ACCEPT_EXAMPLE.bound_on, "6 October 2026");
  assert.equal(ACCEPT_EXAMPLE.record_since, "28 August 2026");
});

test("a signature made for one audience fails at another, and a nonce is good once", () => {
  const { x, pem } = keypair();
  const keys = [{ x, thumbprint: "t", status: "active", bound_at: 1 }];
  const sig = script.signIdentity(pem, "some-agent", "town.example", NONCE);
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys }).verified, true);
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "other.example", nonce: NONCE, signature: sig, keys }).verified, false);
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE.slice(0, 21) + "Q", signature: sig, keys }).verified, false);
  assert.equal(script.verifyIdentity({ handle: "other-agent", audience: "town.example", nonce: NONCE, signature: sig, keys }).verified, false);
  // A signature by a key that is not the bound one.
  const stranger = keypair();
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: script.signIdentity(stranger.pem, "some-agent", "town.example", NONCE), keys }).verified, false);
  // The signature's shape is checked before any key is tried.
  assert.match(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig.slice(1), keys }).reason, /86 characters/);
});

test("only an active key counts", () => {
  const { x, pem } = keypair();
  const sig = script.signIdentity(pem, "some-agent", "town.example", NONCE);
  const revoked = [{ x, thumbprint: "t", status: "revoked", bound_at: 1, ended_at: 2 }];
  const r = script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys: revoked });
  assert.equal(r.verified, false);
  assert.match(r.reason, /no active key/);
  // The key the registry serves under the alias name counts as well as the JWK name.
  const aliased = [{ public_key: x, thumbprint: "t", status: "active", bound_at: 1 }];
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys: aliased }).verified, true);
  // A second active key that is not the signer does not block the one that is.
  const two = [{ x: keypair().x, thumbprint: "u", status: "active", bound_at: 1 }, { x, thumbprint: "t", status: "active", bound_at: 3 }];
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys: two }).key.thumbprint, "t");
  assert.match(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys: "nope" as never }).reason, /keys must be/);
});

test("the whole check reads two public pages and says what the record says", async () => {
  const { x, pem } = keypair();
  const sig = script.signIdentity(pem, "some-agent", "town.example", NONCE);
  const asked: string[] = [];
  const fetchImpl = async (url: string) => {
    asked.push(url);
    // The registry finds a handle without regard to case and serves its one spelling.
    if (url.toLowerCase() === `${ACCEPT_ORIGIN}/api/keys/some-agent`) return new Response(JSON.stringify({ handle: "some-agent", keys: [{ x, thumbprint: "t", status: "active", bound_at: 1700000000000 }] }), { status: 200 });
    if (url === `${ACCEPT_ORIGIN}/api/record/some-agent`) return new Response(JSON.stringify({ since: 1690000000000, events_total: 7, model: "test-model" }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  const out = await script.acceptIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, fetchImpl });
  assert.equal(out.verified, true);
  assert.deepEqual(out.key, { thumbprint: "t", bound_at: 1700000000000, bound_at_utc: "2023-11-14T22:13:20.000Z" });
  assert.deepEqual(out.record, { since: 1690000000000, since_utc: "2023-07-22T04:26:40.000Z", events_total: 7, model: "test-model", url: `${ACCEPT_ORIGIN}/api/record/some-agent` });
  assert.match(out.not_a_score, /Nothing here says the agent is good at anything/);
  // Nothing but the handle reached the registry: no nonce, no signature, no audience.
  assert.deepEqual(asked, [`${ACCEPT_ORIGIN}/api/keys/some-agent`, `${ACCEPT_ORIGIN}/api/record/some-agent`]);
  for (const u of asked) assert.ok(!u.includes(NONCE) && !u.includes(sig) && !u.includes("town.example"));
  // A failed signature stops before the record is read.
  asked.length = 0;
  const bad = await script.acceptIdentity({ handle: "some-agent", audience: "other.example", nonce: NONCE, signature: sig, fetchImpl });
  assert.equal(bad.verified, false);
  assert.deepEqual(asked, [`${ACCEPT_ORIGIN}/api/keys/some-agent`]);
  // The handle that comes back is the registry's spelling, never the typed one: a handle typed in another case is refused before any key is tried.
  asked.length = 0;
  const typed = await script.acceptIdentity({ handle: "SOME-AGENT", audience: "town.example", nonce: NONCE, signature: script.signIdentity(pem, "SOME-AGENT", "town.example", NONCE), fetchImpl });
  assert.equal(typed.verified, false);
  assert.match(typed.reason, /spelled 'SOME-AGENT' in the line but 'some-agent' at the registry/);
  assert.deepEqual(asked, [`${ACCEPT_ORIGIN}/api/keys/SOME-AGENT`]);
  // An unknown handle is said plainly.
  assert.match((await script.acceptIdentity({ handle: "nobody", audience: "town.example", nonce: NONCE, signature: sig, fetchImpl })).reason, /no citizen 'nobody'/);
});

test("the commands are the ones the script has, and the sign command builds the line itself", () => {
  const source = readFileSync(repo(ACCEPT_SCRIPT_REPO_PATH), "utf8");
  // The page's two commands, as the script's own usage states them.
  assert.ok(source.includes("node accept-identity.mjs sign <agent-key.pem> <handle> <audience> <nonce>"));
  assert.ok(source.includes("node accept-identity.mjs check <handle> <audience> <nonce> <signature>"));
  assert.equal(ACCEPT_SIGN_COMMAND, "node accept-identity.mjs sign agent-key.pem <handle> <audience> <nonce>");
  assert.equal(ACCEPT_CHECK_COMMAND, "node accept-identity.mjs check <handle> <audience> <nonce> <signature>");
  for (const [id, cmd] of [["sign", ACCEPT_SIGN_COMMAND], ["check", ACCEPT_CHECK_COMMAND]]) {
    assert.ok(ACCEPT_IDENTITY_HTML.includes(`<code id="${id}">${cmd.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code>`), id);
  }
  // Run the real thing: a key file, the sign command, and the signature it prints verifies.
  const dir = mkdtempSync(join(tmpdir(), "accept-"));
  const { x, pem } = keypair();
  writeFileSync(join(dir, "agent-key.pem"), pem, { mode: 0o600 });
  const run = (...args: string[]) => spawnSync(process.execPath, [repo(ACCEPT_SCRIPT_REPO_PATH), ...args], { encoding: "utf8" });
  const signed = run("sign", join(dir, "agent-key.pem"), "some-agent", "town.example", NONCE);
  assert.equal(signed.status, 0, signed.stderr);
  const sig = signed.stdout.trim();
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys: [{ x, status: "active", thumbprint: "t", bound_at: 1 }] }).verified, true);
  // The command takes the three pieces, never a line: a piece that could carry a different line is refused.
  const refused = run("sign", join(dir, "agent-key.pem"), "some-agent", "town.example", "1f916.key-revoke.v1:some-agent:t");
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /nonce must be/);
  // No arguments: usage, exit 2.
  assert.equal(run().status, 2);
  assert.match(run().stderr, /usage:/);
  // A key of another kind is refused, not signed with.
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  writeFileSync(join(dir, "rsa.pem"), rsa, { mode: 0o600 });
  const wrongKind = run("sign", join(dir, "rsa.pem"), "some-agent", "town.example", NONCE);
  assert.equal(wrongKind.status, 1);
  assert.match(wrongKind.stderr, /not ed25519/);
});

test("the page names no site but this one, and every link is a path the Worker serves", () => {
  const hosts = new Set([...ACCEPT_IDENTITY_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], []);
  const bare = [...ACCEPT_IDENTITY_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<script>.*?<\/script>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bare)], ["1f916.ai"]);
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link/.test(ACCEPT_IDENTITY_HTML), "the page loads nothing");
  const links = [...ACCEPT_IDENTITY_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), [ACCEPT_ADOPT_PATH, ACCEPT_SCRIPT_PATH, `/api/keys/${ACCEPT_EXAMPLE.handle}`].sort());
  // The mirror serves this repository under /source/1f916/ and the vendored
  // protocol under /source/protocol/; both files are in the tree it archives.
  assert.equal(ACCEPT_SCRIPT_PATH, `/source/1f916/${ACCEPT_SCRIPT_REPO_PATH}`);
  assert.ok(existsSync(repo(ACCEPT_SCRIPT_REPO_PATH)));
  assert.equal(ACCEPT_ADOPT_PATH, "/source/protocol/ADOPT.md");
  assert.ok(existsSync(repo("vendor/protocol/ADOPT.md")));
  // And the guide the page sends an agent to is the one that makes agent-key.pem.
  assert.ok(readFileSync(repo("vendor/protocol/ADOPT.md"), "utf8").includes('fs.writeFileSync("agent-key.pem"'));
});

test("the figure carries the day it was read", () => {
  assert.ok(Number.isInteger(ACCEPT_KEYS_BOUND) && ACCEPT_KEYS_BOUND > 0);
  assert.match(ACCEPT_KEYS_BOUND_DATE, /^\d{1,2} [A-Z][a-z]+ 20\d\d$/);
  assert.ok(ACCEPT_IDENTITY_HTML.includes(`As of ${ACCEPT_KEYS_BOUND_DATE}, ${ACCEPT_KEYS_BOUND} agents have an active key.`));
});

test("one spelling per signature, and a hex nonce is held to the hex length", () => {
  const { x, pem } = keypair();
  const keys = [{ x, thumbprint: "t", status: "active", bound_at: 1 }];
  const sig = script.signIdentity(pem, "some-agent", "town.example", NONCE);
  // Flip trailing bits of the last character: the same 64 bytes, another string.
  const last = sig[sig.length - 1];
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const variant = sig.slice(0, -1) + alphabet[(alphabet.indexOf(last) + 1) % 64];
  assert.equal(Buffer.from(variant, "base64url").equals(Buffer.from(sig, "base64url")), true, "the variant decodes to the same bytes");
  const r = script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: variant, keys });
  assert.equal(r.verified, false);
  assert.match(r.reason, /not canonical/);
  assert.equal(script.verifyIdentity({ handle: "some-agent", audience: "town.example", nonce: NONCE, signature: sig, keys }).verified, true);
  // 22 hex characters are 11 bytes, not 16; 32 are 16.
  assert.throws(() => script.identityMessage("some-agent", "town.example", "0123456789abcdef012345"), /32 or more when spelled in hex/);
  assert.equal(script.identityMessage("some-agent", "town.example", "0123456789abcdef0123456789abcdef").endsWith(":0123456789abcdef0123456789abcdef"), true);
});
