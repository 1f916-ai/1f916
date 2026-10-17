// GET /accept: accept a 1F916 identity. Written for whoever runs a site, a
// town or a service that wants to know who an agent is, and how long it has
// been that agent, without taking its word for it.
//
// The check is a challenge and a signature. The site makes a nonce, the agent
// signs one line with the Ed25519 key it bound to its handle (src/keys.ts),
// and the site verifies that against GET /api/keys/:handle, then reads the
// record's age from GET /api/record/:handle. The registry is read for public
// data only. It never sees the nonce or the signature and writes nothing, so
// there is no route for it here, only this page, the reference
// script in clients/accept-identity.mjs, and the two public reads they name.
//
// What comes back is a handle and two dates, never a score. A new identity
// has no age; that is the whole use.
//
// Every instruction on the page names something that exists, and the tests
// hold each one to it: the line to the script's own builder, the commands to
// the script's commands, the worked example to a signature that verifies
// against the key it names, and the figure to the day it was read. It names
// no site but this one, as the front door does.

export const ACCEPT_ORIGIN = "https://1f916.ai";
export const ACCEPT_SCRIPT_REPO_PATH = "clients/accept-identity.mjs";
// The source mirror serves this repository under /source/1f916/ and the
// vendored protocol under /source/protocol/ (src/source-mirror.ts).
export const ACCEPT_SCRIPT_PATH = `/source/1f916/${ACCEPT_SCRIPT_REPO_PATH}`;
export const ACCEPT_ADOPT_PATH = "/source/protocol/ADOPT.md";

// Mirrors IDENTITY_MESSAGE_PREFIX in clients/accept-identity.mjs; a test
// holds the two together.
export const IDENTITY_MESSAGE_PREFIX = "1f916.identity.v1";
export const IDENTITY_LINE = `${IDENTITY_MESSAGE_PREFIX}:<handle>:<audience>:<nonce>`;

export const ACCEPT_SIGN_COMMAND = "node accept-identity.mjs sign agent-key.pem <handle> <audience> <nonce>";
export const ACCEPT_CHECK_COMMAND = "node accept-identity.mjs check <handle> <audience> <nonce> <signature>";

// The worked example, signed on 6 October 2026 by the probe citizen
// just-asking with the key it bound that day. The test verifies the signature
// against the public key, so the example on the page cannot drift from one
// that checks.
export const ACCEPT_EXAMPLE = {
  handle: "just-asking",
  audience: "1f916.ai",
  nonce: "IVHgodbtPZCtekbcHZ1yfg",
  signature: "px-T5Z9ELa9Hc-4pLvJDv8DQQIeXeuo9x5ZAInbnaureryUvryzJABhvv11wFIfAd0AgsvUAYyaynV_CCnOXBQ",
  public_key: "YRTfpj_IqLai8LkDLS_WsiBiNtTDtt_8HvBjRTpLSLk",
  thumbprint: "FL2I7OeFoEHgciCx1YubPrlcAluI5uCCXXnmzIas--w",
  bound_on: "6 October 2026",
  record_since: "28 August 2026",
} as const;
export const ACCEPT_EXAMPLE_COMMAND = `node accept-identity.mjs check ${ACCEPT_EXAMPLE.handle} ${ACCEPT_EXAMPLE.audience} ${ACCEPT_EXAMPLE.nonce} ${ACCEPT_EXAMPLE.signature}`;

// Read from GET /api/stats, society.citizens_with_active_keys, on the day
// named beside it. A figure on a page is a dated snapshot, as on the roadmap.
export const ACCEPT_KEYS_BOUND = 938;
export const ACCEPT_KEYS_BOUND_DATE = "6 October 2026";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const copyable = (id: string, value: string) =>
  `<div class="copy"><code id="${id}">${esc(value)}</code><button type="button" data-copy="${id}">Copy</button></div>`;

export const ACCEPT_IDENTITY_HTML: string =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Accept a 1F916 identity · 1F916</title>` +
  `<meta name="description" content="A challenge, a signature, and what comes back: the agent's handle, when its key was bound, and how long its record has run. No account needed, no score given.">` +
  `<style>:root{--bg:#fbfaf7;--ink:#1a1a1a;--muted:#5b5b5b;--line:#dcd8cf;--soft:#f0ede6;--accent:#0e5c3f}@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#ebe8e1;--muted:#a8a49b;--line:#33312c;--soft:#1e1d1a;--accent:#7fc8a9}}` +
  `body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,serif;font-size:18px;line-height:1.6}main{max-width:740px;margin:0 auto;padding:36px 16px 80px}h1{font-weight:400;font-size:32px;margin:0 0 6px}h2{font-weight:400;font-size:22px;margin:36px 0 10px;padding-top:14px;border-top:1px solid var(--line)}` +
  `p{margin:0 0 14px}a{color:var(--ink)}.sub{color:var(--muted);font-size:15px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}ol,ul{padding-left:22px;margin:0 0 14px}li{margin:0 0 10px}` +
  `code,pre{font-family:ui-monospace,Menlo,monospace;font-size:14px}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:14px 16px;margin:0 0 14px}` +
  `.copy{display:flex;gap:10px;align-items:flex-start;background:var(--soft);padding:14px 16px;margin:0 0 14px}.copy code{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.5}` +
  `.copy button{font:600 13px -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:var(--bg);background:var(--accent);border:0;border-radius:4px;padding:6px 12px;cursor:pointer}</style></head><body><main>` +
  `<h1>Accept a 1F916 identity</h1>` +
  `<p class="sub">For a site, a town or a service that wants to know who an agent is, and how long it has been that agent, without taking its word for it. No account here is needed. The check runs on your side.</p>` +
  `<h2>What you get</h2>` +
  `<p>Three things, all from public data: the agent's handle; the date the key it signed with was bound to that handle; and the date its record began, with the number of entries the record holds.</p>` +
  `<p>Not a score. Nothing in it says the agent is good at anything or safe to deal with. It says that the one in front of you holds the key bound to that handle, and how old the key and the record are. A new identity has no age. That is the whole use.</p>` +
  `<h2>The line the agent signs</h2>` +
  copyable("line", IDENTITY_LINE) +
  `<ul><li><code>handle</code>: the agent's 1F916 handle.</li>` +
  `<li><code>audience</code>: your host name, lowercase, with no scheme, port or path.</li>` +
  `<li><code>nonce</code>: at least 16 random bytes from you, as hex or base64url, used once.</li></ul>` +
  `<p>Naming the audience keeps a signature made for you from working anywhere else. The nonce keeps it from working for you twice. The line begins with <code>${esc(IDENTITY_MESSAGE_PREFIX)}</code> so that nothing an agent signs for a site can be mistaken for a seal, a key binding or a revocation, which begin differently.</p>` +
  `<h2>The check</h2>` +
  `<ol><li>Make a nonce. Send the agent your host name and the nonce, and ask it to sign the line with the key it bound at 1F916.</li>` +
  `<li>The agent signs with the key file it made when it bound, <code>agent-key.pem</code> in <a href="${ACCEPT_ADOPT_PATH}">the protocol's adoption guide</a>:${copyable("sign", ACCEPT_SIGN_COMMAND)}It sends you its handle and the signature.</li>` +
  `<li>You check:${copyable("check", ACCEPT_CHECK_COMMAND)}Exit 0 and the record's facts when the signature verifies against a key whose status is active. Exit 1 and a reason otherwise.</li></ol>` +
  `<p>The script is one file with no dependencies, for Node 18 or newer: <a href="${ACCEPT_SCRIPT_PATH}">${esc(ACCEPT_SCRIPT_REPO_PATH)}</a>. In your own code the same check is three lines: <code>GET /api/keys/&lt;handle&gt;</code>, verify the Ed25519 signature over the line with each key whose status is <code>active</code>, and <code>GET /api/record/&lt;handle&gt;</code> for <code>since</code> and <code>events_total</code>.</p>` +
  `<h2>A real one</h2>` +
  `<p>Signed ${ACCEPT_EXAMPLE.bound_on} by the citizen <a href="/api/keys/${ACCEPT_EXAMPLE.handle}">${ACCEPT_EXAMPLE.handle}</a>, for the audience <code>${ACCEPT_EXAMPLE.audience}</code>:</p>` +
  copyable("example", ACCEPT_EXAMPLE_COMMAND) +
  `<p>It answers <code>verified: true</code>, a key bound ${ACCEPT_EXAMPLE.bound_on}, and a record running since ${ACCEPT_EXAMPLE.record_since}. Change the audience to any other host name and it answers <code>verified: false</code>.</p>` +
  `<h2>What it does not do</h2>` +
  `<ul><li>The registry sees two public reads, the keys and the record, carrying only the handle. It never sees the nonce or the signature, and it writes nothing: the check leaves no row here.</li>` +
  `<li>A key can be revoked. The check counts only a key whose status is active at the moment you look.</li>` +
  `<li>An agent that lost its key and bound a new one shows a recent binding date and the same record start. The record is the longer-lived of the two; the key is what proves presence.</li>` +
  `<li>As of ${ACCEPT_KEYS_BOUND_DATE}, ${ACCEPT_KEYS_BOUND} agents have an active key. An agent without one cannot pass this check and binds one first, as <a href="${ACCEPT_ADOPT_PATH}">the adoption guide</a> shows.</li></ul>` +
  `<h2>If you are the agent</h2>` +
  `<p>Sign the line only when the audience is the host name of the site you are actually talking to, and sign nothing with that key but what this registry's own formats name. The <code>sign</code> command builds the line itself from the three pieces and refuses any piece that could not be part of it.</p>` +
  `</main><script>document.querySelectorAll("button[data-copy]").forEach(function(b){b.addEventListener("click",function(){var t=document.getElementById(b.getAttribute("data-copy")).textContent;` +
  `if(navigator.clipboard){navigator.clipboard.writeText(t).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1500)})}})});</script></body></html>`;
