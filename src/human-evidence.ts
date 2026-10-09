// GET /human/evidence: log integrity evidence, for whoever has to show an
// auditor that an agent's log was not changed after the fact.
//
// The page maps what this registry holds onto one published control, in the
// standard's own words, and says how an auditor checks each claim without
// trusting anyone here. The mapping is ours; what counts as evidence is the
// auditor's call, and the page says so. It does not say "required",
// "certified" or "compliant", because the control it maps to is supplemental
// and we certify nothing.
//
// Every quotation is pinned to the text as read on the day named beside it,
// every command names a route this Worker serves or a flag the checker has,
// and the figure carries its date. The tests hold each to the thing it names.
import { SEAL_TEXT_MAX } from "./seals.ts";
import { RESEARCH_SNAPSHOT } from "./research-snapshot.ts";

export const EVIDENCE_ORIGIN = "https://1f916.ai";
export const EVIDENCE_READ_DATE = "6 October 2026";

// The standard, quoted. Read 2026-10-06 from standard.aiuc-1.com/accountability
// (the requirement) and standard.aiuc-1.com/evidence/index (the controls and
// the evidence each names). A quotation here is the page's whole claim about
// the standard, so change nothing in these strings without re-reading the
// source on a date you then write above.
export const EVIDENCE_STANDARD = "AIUC-1";
export const EVIDENCE_STANDARD_SITE = "standard.aiuc-1.com";
export const E015_TITLE = "Log AI system activity";
export const E015_TEXT = "Maintain logs of AI system processes, actions, and agent outputs where permitted to support incident investigation, auditing, and explanation of AI system behavior";
export const E015_4_TITLE = "Log integrity protection";
export const E015_4_TEXT = "Implementing technical controls to ensure logs are tamper-evident and independently verifiable. For example, ensuring that captured records cannot be modified or deleted after creation, ensuring sequence integrity so that gaps, omissions, and reordering are detectable during incident investigation or audit.";
export const E015_4_EVIDENCE = "Log immutability controls - for example, write-once-read-many (WORM) storage configuration, cryptographic hashing of log entries, append-only database settings, or third-party log management platform features.";
export const E015_SIBLINGS = [
  { id: "E015.1", title: "Logging implementation", level: "mandatory" },
  { id: "E015.2", title: "AI agent logging implementation", level: "supplemental" },
  { id: "E015.3", title: "Log storage", level: "mandatory" },
] as const;

// The log's size and its signed head's coverage come from the research
// snapshot taken the same day (src/research-snapshot.ts), so the two pages
// give one figure.
export const EVIDENCE_SNAPSHOT = RESEARCH_SNAPSHOT;

// The routes and the checker flags the page tells an auditor to use. Each is
// held to the Worker or to vendor/protocol/verify.mjs by the tests.
export const EVIDENCE_ROUTES = {
  record: "/api/mandates/<id>",
  proof: "/api/proof?log=identity_events&event=<event_id>",
  witnesses: "/api/witnesses",
  anchors: "/api/anchors",
  dossier: "/api/record/<handle>",
  consistency: "/api/checkpoint/consistency?log=identity_events&from=<older tree size>&to=<newer tree size>",
  checkpoint: "/api/checkpoint",
} as const;
export const EVIDENCE_CHECKER_PATH = "/source/protocol/verify.mjs";
export const EVIDENCE_CHECKER_COMMAND = "node verify.mjs --dossier record.json --registry-key <registry_public_key>";
export const EVIDENCE_SETUP_PATH = "/human/setup";
export const EVIDENCE_RESEARCH_PATH = "/human/research";

export const EVIDENCE_COMMANDS = [
  `curl -s ${EVIDENCE_ORIGIN}${EVIDENCE_ROUTES.record}`,
  `curl -s "${EVIDENCE_ORIGIN}${EVIDENCE_ROUTES.proof}"`,
  `curl -s ${EVIDENCE_ORIGIN}${EVIDENCE_ROUTES.witnesses}`,
  `curl -s ${EVIDENCE_ORIGIN}${EVIDENCE_ROUTES.anchors}`,
  `curl -s ${EVIDENCE_ORIGIN}${EVIDENCE_ROUTES.dossier} > record.json && ${EVIDENCE_CHECKER_COMMAND}`,
] as const;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const pre = (s: string) => `<pre>${esc(s)}</pre>`;

export const HUMAN_EVIDENCE_HTML: string =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Log integrity evidence · 1F916</title>` +
  `<meta name="description" content="What a 1F916 record proves about an agent's log, mapped onto one published audit control in the standard's own words, with the commands an auditor runs to check it.">` +
  `<style>:root{--bg:#fbfaf7;--ink:#1a1a1a;--muted:#5b5b5b;--line:#dcd8cf;--soft:#f0ede6;--accent:#0e5c3f}@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#ebe8e1;--muted:#a8a49b;--line:#33312c;--soft:#1e1d1a;--accent:#7fc8a9}}` +
  `body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,serif;font-size:18px;line-height:1.6}main{max-width:740px;margin:0 auto;padding:36px 16px 80px}h1{font-weight:400;font-size:32px;margin:0 0 6px}h2{font-weight:400;font-size:22px;margin:36px 0 10px;padding-top:14px;border-top:1px solid var(--line)}` +
  `p{margin:0 0 14px}a{color:var(--ink)}.sub{color:var(--muted);font-size:15px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}ol,ul{padding-left:22px;margin:0 0 14px}li{margin:0 0 10px}blockquote{margin:0 0 14px;padding:0 0 0 16px;border-left:3px solid var(--line)}` +
  `code,pre{font-family:ui-monospace,Menlo,monospace;font-size:14px}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:14px 16px;margin:0 0 14px}` +
  `table{border-collapse:collapse;width:100%;margin:0 0 14px;font-size:16px}th,td{text-align:left;vertical-align:top;padding:8px 10px 8px 0;border-top:1px solid var(--line)}th{font-weight:400;color:var(--muted);font-size:14px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}</style></head><body><main>` +
  `<h1>Log integrity evidence</h1>` +
  `<p class="sub">For whoever has to show an auditor that an agent's log was not changed after the fact. What a record here holds, what it proves, and how an auditor checks it without trusting anyone here. Written against one published standard's wording. The mapping is ours; what counts as evidence is the auditor's call.</p>` +
  `<h2>The control, in the standard's words</h2>` +
  `<p>${esc(EVIDENCE_STANDARD)} is a standard for AI agents. Its control E015, “${esc(E015_TITLE)}”, is labelled mandatory:</p>` +
  `<blockquote>${esc(E015_TEXT)}</blockquote>` +
  `<p>Its evidence guidance lists four controls under E015, each on a row that carries the requirement's label, a description, the control's line and the control's own label. Three concern what is logged and where it is kept: ${E015_SIBLINGS.map((s) => `${s.id} (${esc(s.title)}, ${s.level})`).join(", ")}. The fourth is the one an outside record answers. Its row describes the control as:</p>` +
  `<blockquote>${esc(E015_4_TEXT)}</blockquote>` +
  `<p>The control's line on that row, “E015.4 Config: ${esc(E015_4_TITLE)}”, is labelled a supplemental control, and the evidence it names is:</p>` +
  `<blockquote>${esc(E015_4_EVIDENCE)}</blockquote>` +
  `<p class="sub">Read ${EVIDENCE_READ_DATE} from the standard's evidence guidance and its accountability domain at ${esc(EVIDENCE_STANDARD_SITE)}. The pages read define neither label; we read supplemental as not required. We are not an auditor, certify nothing, and have no connection to the standard's authors.</p>` +
  `<h2>What a record here holds</h2>` +
  `<p>Your agent keeps its log where it keeps it. What it sends here, as it acts, is a record: a fingerprint of what it was told, a fingerprint of what it did, and later a fingerprint of what came of it. Fingerprints are the default, so a log with customer data in it leaves nothing here but hashes; an agent can send the text instead, up to ${SEAL_TEXT_MAX.toLocaleString("en-US")} characters, and unless it asks for the text to be kept openly, the registry fingerprints it and keeps nothing. If your log is already a hash chain, the agent can seal the chain's head and its length here on a schedule instead of each entry.</p>` +
  `<p>Each record is an entry in the registry's one chain, in which every entry since the chain began carries a hash, and every one after the first of them commits to the one before it, whoever wrote that one. Once a head covers it, it has a fixed position in a tree whose signed head is published at <code>${EVIDENCE_ROUTES.checkpoint}</code> by a stamp attempted every five minutes; witnesses that are not us countersign the heads they see, on schedules of their own; and the heads are offered to Bitcoin (through OpenTimestamps), to Base and to the Internet Archive, each attempt listed with its status. At <a href="${EVIDENCE_RESEARCH_PATH}">the research snapshot</a> of ${EVIDENCE_SNAPSHOT.date} the log held ${EVIDENCE_SNAPSHOT.events.toLocaleString("en-US")} entries, of which the newest signed head covered ${EVIDENCE_SNAPSHOT.tree_size.toLocaleString("en-US")}; the first ${EVIDENCE_SNAPSHOT.unchained_rows} were written before the chain began.</p>` +
  `<h2>The mapping</h2>` +
  `<table><tr><th>What E015.4 asks</th><th>What the record gives</th><th>Where to check</th></tr>` +
  `<tr><td>Records cannot be modified after creation</td><td>A record's <code>commit</code> is the sha-256 of its <code>commit_payload</code>, which carries the fingerprints; the commit is sealed into a chained event. Change a byte and the hash differs from what was sealed.</td><td><code>${esc(EVIDENCE_ROUTES.record)}</code>, then the <code>proof</code> link it carries</td></tr>` +
  `<tr><td>Records cannot be deleted after creation</td><td>Every event since the chain began has a position in a signed tree once a head covers it, and a later head covers every earlier one. Removing an entry changes the tree and breaks the consistency proof against every witness's copy of the earlier head.</td><td><code>${esc(EVIDENCE_ROUTES.consistency)}</code>, compared with the witness files at <code>${EVIDENCE_ROUTES.witnesses}</code></td></tr>` +
  `<tr><td>Gaps, omissions and reordering are detectable</td><td>Events have sequential ids and, once a head covers them, fixed tree positions. An entry in your log with no record here shows when the log is walked against the series of records; an entry here that your log lacks is an omission from the log; the order of what was recorded is fixed by position and cannot be rewritten without breaking the proofs.</td><td><code>${esc(EVIDENCE_ROUTES.dossier)}</code>, the chained events with inclusion proofs</td></tr>` +
  `<tr><td>Independently verifiable</td><td>The dossier verifies offline against the registry's public key; witnesses hold their own signed copies of the heads; the anchors are on chains and in an archive nobody here controls.</td><td><code>${EVIDENCE_ROUTES.anchors}</code>, and the checker at <a href="${EVIDENCE_CHECKER_PATH}">verify.mjs</a></td></tr></table>` +
  `<h2>For the auditor, in five commands</h2>` +
  `<ol><li>The record, its fingerprints and its event id:${pre(EVIDENCE_COMMANDS[0])}</li>` +
  `<li>Its inclusion proof under a signed head:${pre(EVIDENCE_COMMANDS[1])}</li>` +
  `<li>The witnesses registered here, each with the address of its copies and its public key where it gave one. Fetch a copy to see what it countersigned and when:${pre(EVIDENCE_COMMANDS[2])}</li>` +
  `<li>The heads offered to Bitcoin, Base and the Internet Archive, each with its status. A Bitcoin row stays <code>pending</code> here by design; the reader confirms it with an OpenTimestamps client, and this page calls none of them confirmed:${pre(EVIDENCE_COMMANDS[3])}</li>` +
  `<li>Offline, with the checker and the registry's public key as <code>${EVIDENCE_ROUTES.checkpoint}</code> publishes it:${pre(EVIDENCE_COMMANDS[4])}</li></ol>` +
  `<h2>What it does not do</h2>` +
  `<ul><li>It is not your logging implementation and not your log storage. What you capture, how long you keep it, who can read it and what you mask are yours to show under E015.1, E015.2 and E015.3.</li>` +
  `<li>It proves that a record existed, unchanged, from the first signed head after it was sealed; a stamp is attempted every five minutes. It does not prove the record was true or complete, or that the agent did what the record says.</li>` +
  `<li>It sees only what was sent. An entry never recorded here is invisible to it, so coverage is yours to show: every entry, or the head of your own chain on a schedule.</li>` +
  `<li>Whether this satisfies an auditor is the auditor's call. On ${EVIDENCE_READ_DATE} we sent the standard's authors a suggestion that the examples under E015.4 include checkpoints held by a party outside the operator's control. Nothing on this page should be read as their answer.</li></ul>` +
  `<p class="sub">To give an agent a record: <a href="${EVIDENCE_SETUP_PATH}">1f916.ai${EVIDENCE_SETUP_PATH}</a>.</p>` +
  `</main></body></html>`;
