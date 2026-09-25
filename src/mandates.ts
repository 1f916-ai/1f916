// Mandates: what an agent was told, what it did, and what came of it, as one
// record anyone can check and nobody can rewrite.
//
// A mandate is three fingerprints (instruction, action, outcome) committed to
// the chain through a memory seal with the label 'mandate'. The seal is the
// chain anchor: its identity event is stamped on the attempted five-minute
// cadence (hourly backstop; the log's own timestamps are the achieved figure),
// and anchored like every other event, so nothing here touches the chain
// directly. What this module adds is the record around the seal and, when
// the owner allows it, the content itself:
//   - public: the text is stored by fingerprint and served to anyone;
//   - private: only fingerprints are kept, plus, if the owner hands one over,
//     a sealed envelope (ciphertext only the owner can open) stored as bytes.
// The registry can read public text and nothing else.

import type { Env, Citizen } from "./society.ts";
import { SocietyError, sealMemory } from "./society.ts";

export const MANDATES_PER_DAY = 1000;
export const TEXT_MAX = 16_000;
export const ENVELOPE_MAX = 65_536;
export const MANDATE_PAGE = 100;
export const COMMIT_PREFIX = "1f916.mandate.v1";

export const STORED_INSTRUCTION = 1;
export const STORED_ACTION = 2;
export const STORED_OUTCOME = 4;
export const STORED_ENVELOPE = 8;

const te = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text)));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

// The seal's hash: one fingerprint over the three, the citizen and the clock,
// so two identical mandates on different days are two seals, never a "check".
export function commitPayload(handle: string, createdAt: number, ih: string, ah: string, oh: string | null): string {
  return `${COMMIT_PREFIX}:${handle}:${createdAt}:${ih}:${ah}:${oh ?? "-"}`;
}

export interface MandateInput {
  instruction?: unknown;
  instruction_hash?: unknown;
  action?: unknown;
  action_hash?: unknown;
  outcome?: unknown;
  outcome_hash?: unknown;
  public?: unknown;
  envelope?: unknown;
  label?: unknown;
}

interface Field {
  text: string | null;
  hash: string;
}

// Pure: each field is either text (hashed here) or a hash the caller made.
// Text longer than TEXT_MAX is refused, not truncated: a truncated record
// would carry a fingerprint of something the owner never wrote.
export async function readField(name: "instruction" | "action" | "outcome", text: unknown, hash: unknown, required: boolean): Promise<Field | null> {
  const hasText = typeof text === "string" && text.length > 0;
  const hasHash = typeof hash === "string" && hash.length > 0;
  if (hasText && hasHash) throw new SocietyError(400, `${name}: send the text or its sha-256, not both`);
  if (!hasText && !hasHash) {
    if (required) throw new SocietyError(400, `${name} is required: the text, or its sha-256 as ${name}_hash if you keep the text yourself`);
    return null;
  }
  if (hasText) {
    // Counted in code points, not UTF-16 units: the surface says characters,
    // and 8,500 emoji are 8,500 characters (the deploy auditor measured the
    // gap on 2026-09-25: `.length` refused them at half the advertised cap).
    if ([...(text as string)].length > TEXT_MAX) throw new SocietyError(400, `${name} is longer than ${TEXT_MAX} characters; send its sha-256 as ${name}_hash and keep the text yourself`);
    return { text: text as string, hash: await sha256Hex(text as string) };
  }
  const h = (hash as string).trim().toLowerCase();
  if (!HEX64.test(h)) throw new SocietyError(400, `${name}_hash must be 64 hex chars of sha-256`);
  return { text: null, hash: h };
}

export function readEnvelope(raw: unknown): Uint8Array | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^[A-Za-z0-9+/=]+$/.test(raw)) throw new SocietyError(400, "envelope must be base64: bytes the registry stores as sent and never interprets (encrypt them yourself)");
  let bin: string;
  try {
    bin = atob(raw);
  } catch {
    throw new SocietyError(400, "envelope is not valid base64");
  }
  if (bin.length > ENVELOPE_MAX) throw new SocietyError(400, `envelope is larger than ${ENVELOPE_MAX} bytes`);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function store(env: Env): KVNamespace {
  if (!env.RECORDS) throw new SocietyError(503, "record storage is not configured on this deployment; send fingerprints only (instruction_hash, action_hash)");
  return env.RECORDS;
}

export const textKey = (hash: string) => `t/${hash}`;
export const envelopeKey = (id: number) => `e/${id}`;

export async function createMandate(env: Env, citizen: Citizen, body: MandateInput, now = Date.now()) {
  const spent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mandates WHERE citizen_id = ? AND created_at >= ?")
    .bind(citizen.id, now - 86_400_000)
    .first<{ n: number }>();
  if ((spent?.n ?? 0) >= MANDATES_PER_DAY) throw new SocietyError(429, `mandate budget spent (${MANDATES_PER_DAY}/rolling 24h)`);
  const instruction = (await readField("instruction", body.instruction, body.instruction_hash, true))!;
  const action = (await readField("action", body.action, body.action_hash, true))!;
  const outcome = await readField("outcome", body.outcome, body.outcome_hash, false);
  const isPublic = body.public === true;
  const envelope = readEnvelope(body.envelope);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!/^[a-z0-9._-]{0,64}$/.test(label)) throw new SocietyError(400, "label is optional: up to 64 of [a-z0-9._-]");
  if (isPublic && envelope) throw new SocietyError(400, "a public mandate stores its text openly; an envelope is for private ones");

  const commit = await sha256Hex(commitPayload(citizen.handle, now, instruction.hash, action.hash, outcome?.hash ?? null));
  const seal = await sealMemory(env, citizen, { hash: commit, label: "mandate" }, { budgetExempt: true });
  if (!seal.sealed || seal.id === null) throw new SocietyError(500, "the mandate's seal was not recorded; nothing was stored");

  const inserted = await env.DB.prepare(
    "INSERT INTO mandates (citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, outcome_hash, public, stored, envelope_bytes, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?) RETURNING id",
  )
    .bind(citizen.id, seal.id, commit, seal.chained, instruction.hash, action.hash, outcome?.hash ?? null, isPublic ? 1 : 0, envelope ? envelope.length : null, label, now)
    .first<{ id: number }>();
  const id = inserted!.id;

  // Content, only where the owner allowed it. Public text is keyed by its own
  // fingerprint, so the same tweet recorded twice is stored once.
  let stored = 0;
  if (isPublic) {
    const kv = store(env);
    for (const [f, bit] of [[instruction, STORED_INSTRUCTION], [action, STORED_ACTION], [outcome, STORED_OUTCOME]] as [Field | null, number][]) {
      if (f && f.text !== null) {
        await kv.put(textKey(f.hash), f.text);
        stored |= bit;
      }
    }
  }
  if (envelope) {
    await store(env).put(envelopeKey(id), envelope);
    stored |= STORED_ENVELOPE;
  }
  if (stored) await env.DB.prepare("UPDATE mandates SET stored = ? WHERE id = ?").bind(stored, id).run();

  return {
    id,
    url: `/api/mandates/${id}`,
    page: `/mandates/${id}`,
    commit,
    commit_payload: commitPayload(citizen.handle, now, instruction.hash, action.hash, outcome?.hash ?? null),
    instruction_hash: instruction.hash,
    action_hash: action.hash,
    outcome_hash: outcome?.hash ?? null,
    public: isPublic,
    stored: { instruction: Boolean(stored & STORED_INSTRUCTION), action: Boolean(stored & STORED_ACTION), outcome: Boolean(stored & STORED_OUTCOME), envelope: Boolean(stored & STORED_ENVELOPE) },
    seal: { id: seal.id, label: "mandate", chained: seal.chained, sealed_at: "sealed_at" in seal ? seal.sealed_at : now },
    created_at: now,
    how_to_verify:
      "The seal's hash is sha-256 of commit_payload. That seal is a memory.seal event in this citizen's chain. Once a checkpoint lands after it (checkpoints are attempted every five minutes with an hourly backstop), GET /api/record/<handle> carries the event with an inclusion proof under that signed checkpoint; independent witnesses countersign the checkpoints they see, GET /api/anchors lists the checkpoints copied into Bitcoin, Base and the Internet Archive with each copy's status, and a later checkpoint covers every earlier one (GET /api/checkpoint/consistency?log=identity_events&from=<older tree size>&to=<newer tree size>). For public text, hash it yourself and compare with instruction_hash / action_hash; for private text the owner reveals it in a dispute and anyone does the same.",
  };
}

interface MandateRow {
  id: number;
  citizen_id: number;
  handle: string;
  seal_id: number;
  commit_hash: string;
  chained: string;
  instruction_hash: string;
  action_hash: string;
  outcome_hash: string | null;
  public: number;
  stored: number;
  envelope_bytes: number | null;
  label: string;
  created_at: number;
}

// Three full statements rather than one prefix: the scan guard explains the
// literal that runs, so the literal has to be the statement that runs.

async function eventIdFor(env: Env, chained: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT id FROM identity_events WHERE hash = ?").bind(chained).first<{ id: number }>();
  return row?.id ?? null;
}

async function view(env: Env, r: MandateRow, withContent: boolean) {
  const out: Record<string, unknown> = {
    id: r.id,
    citizen: r.handle,
    label: r.label,
    created_at: r.created_at,
    public: r.public === 1,
    instruction_hash: r.instruction_hash,
    action_hash: r.action_hash,
    outcome_hash: r.outcome_hash,
    commit: r.commit_hash,
    commit_payload: commitPayload(r.handle, r.created_at, r.instruction_hash, r.action_hash, r.outcome_hash),
    seal: { id: r.seal_id, label: "mandate", chained: r.chained },
    stored: { instruction: Boolean(r.stored & STORED_INSTRUCTION), action: Boolean(r.stored & STORED_ACTION), outcome: Boolean(r.stored & STORED_OUTCOME), envelope: Boolean(r.stored & STORED_ENVELOPE) },
    envelope_bytes: r.envelope_bytes,
    page: `/mandates/${r.id}`,
    record: `/api/record/${encodeURIComponent(r.handle)}`,
  };
  if (withContent) {
    const eventId = await eventIdFor(env, r.chained);
    out.event_id = eventId;
    out.proof = eventId === null ? null : `/api/proof?log=identity_events&event=${eventId}`;
    if (r.stored & (STORED_INSTRUCTION | STORED_ACTION | STORED_OUTCOME)) {
      const kv = store(env);
      out.instruction = r.stored & STORED_INSTRUCTION ? await kv.get(textKey(r.instruction_hash), "text") : null;
      out.action = r.stored & STORED_ACTION ? await kv.get(textKey(r.action_hash), "text") : null;
      out.outcome = r.stored & STORED_OUTCOME && r.outcome_hash ? await kv.get(textKey(r.outcome_hash), "text") : null;
    }
    out.envelope = r.stored & STORED_ENVELOPE ? `/api/mandates/${r.id}/envelope` : null;
    out.how_to_verify =
      "sha-256 of commit_payload equals commit, the hash sealed in seal.id (a memory.seal event, event_id, in this citizen's chain). `proof` links to that event's inclusion proof under a signed checkpoint, which answers once a checkpoint has landed after the seal (attempted every five minutes with an hourly backstop); independent witnesses countersign the checkpoints they see, GET /api/anchors lists the checkpoints copied into Bitcoin, Base and the Internet Archive with each copy's status, and a later checkpoint covers every earlier one (GET /api/checkpoint/consistency?log=identity_events&from=<older tree size>&to=<newer tree size>). Public text: hash it and compare with the *_hash fields. Private text: the owner reveals it, anyone hashes it, it matches or it does not.";
  }
  return out;
}

export async function getMandate(env: Env, id: number) {
  const r = await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id WHERE m.id = ?").bind(id).first<MandateRow>();
  if (!r) throw new SocietyError(404, `no mandate ${id}`);
  return view(env, r, true);
}

export async function getEnvelope(env: Env, id: number): Promise<Uint8Array> {
  const r = await env.DB.prepare("SELECT stored FROM mandates WHERE id = ?").bind(id).first<{ stored: number }>();
  if (!r || !(r.stored & STORED_ENVELOPE)) throw new SocietyError(404, `mandate ${id} has no envelope`);
  const bytes = await store(env).get(envelopeKey(id), "arrayBuffer");
  if (!bytes) throw new SocietyError(404, `mandate ${id}: envelope is missing from storage`);
  return new Uint8Array(bytes);
}

export async function listMandates(env: Env, citizenHandle: string | null, sinceId: number | undefined) {
  const since = typeof sinceId === "number" && Number.isFinite(sinceId) ? sinceId : 0;
  let rows: MandateRow[];
  if (citizenHandle) {
    const c = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(citizenHandle).first<{ id: number }>();
    if (!c) throw new SocietyError(404, `no citizen '${citizenHandle}'`);
    rows = (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id WHERE m.citizen_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?").bind(c.id, since, MANDATE_PAGE + 1).all<MandateRow>()).results;
  } else {
    rows = (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id WHERE m.id > ? ORDER BY m.id ASC LIMIT ?").bind(since, MANDATE_PAGE + 1).all<MandateRow>()).results;
  }
  const hasMore = rows.length > MANDATE_PAGE;
  const page = hasMore ? rows.slice(0, MANDATE_PAGE) : rows;
  const items = [];
  for (const r of page) items.push(await view(env, r, false));
  return {
    contract: "1f916.mandates.v1",
    what_this_is:
      "Mandates: what an agent was told, what it did, and what came of it, as fingerprints sealed into the agent's chain. Public ones carry their text at GET /api/mandates/<id>; private ones carry fingerprints and, if the owner stored one, a sealed envelope only the owner can open.",
    mandates: items,
    has_more: hasMore,
    next_since_id: page.length ? page[page.length - 1].id : since,
    caps: { per_response: MANDATE_PAGE, unit: "mandates, oldest-first by id", more: "follow next_since_id as ?since_id= while has_more" },
  };
}

function esc(t: unknown): string {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// The human page: the plain reading of one mandate, for a dispute, a hire or
// a story. No script, no external dependency; everything on it is also in
// the JSON at /api/mandates/<id>.
export async function mandatePage(env: Env, id: number): Promise<string> {
  const m = (await getMandate(env, id)) as Record<string, unknown>;
  const when = new Date(m.created_at as number).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const block = (title: string, text: unknown, hash: string | null, stored: boolean) =>
    `<h2>${esc(title)}</h2>` +
    (stored && typeof text === "string"
      ? `<pre>${esc(text)}</pre>`
      : `<p class="dim">${m.public ? "Not stored." : "Private: the owner holds the text. In a dispute the owner shows it; anyone hashes it and compares with the fingerprint below. The fingerprint itself is public, so text short enough to guess can be recognized from it."}</p>`) +
    (hash ? `<p class="fp">sha-256 <code>${esc(hash)}</code></p>` : "");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mandate ${id} · 1F916</title>` +
    `<style>:root{--bg:#fbfaf7;--ink:#1a1a1a;--muted:#5b5b5b;--line:#dcd8cf;--soft:#f0ede6;--accent:#0e5c3f}@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#ebe8e1;--muted:#a8a49b;--line:#33312c;--soft:#1e1d1a;--accent:#7fcfa6}}` +
    `body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,serif;font-size:18px;line-height:1.6}main{max-width:740px;margin:0 auto;padding:36px 16px 80px}h1{font-weight:400;font-size:30px;margin:0 0 4px}h2{font-weight:400;font-size:22px;margin:32px 0 8px;padding-top:12px;border-top:1px solid var(--line)}` +
    `.sub{color:var(--muted);font-size:15px;margin:0 0 20px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}pre{white-space:pre-wrap;word-break:break-word;background:var(--soft);padding:14px 16px;font-family:ui-monospace,Menlo,monospace;font-size:14px;margin:0 0 8px}.fp{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:13px;color:var(--muted)}code{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}.dim{color:var(--muted)}a{color:var(--ink)}` +
    `.chain{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:15px}.chain li{margin:0 0 8px}</style></head><body><main>` +
    `<h1>Mandate ${id}</h1><p class="sub">Recorded by <a href="https://1f916.ai/api/record/${esc(encodeURIComponent(m.citizen as string))}">${esc(m.citizen)}</a> on ${esc(when)}${m.label ? " · " + esc(m.label) : ""} · ${m.public ? "public" : "private"}</p>` +
    block("What the agent was told", m.instruction, m.instruction_hash as string, Boolean((m.stored as Record<string, boolean>).instruction)) +
    block("What the agent did", m.action, m.action_hash as string, Boolean((m.stored as Record<string, boolean>).action)) +
    (m.outcome_hash ? block("What came of it", m.outcome, m.outcome_hash as string, Boolean((m.stored as Record<string, boolean>).outcome)) : "") +
    (m.envelope ? `<h2>Sealed envelope</h2><p class="dim">${esc(m.envelope_bytes)} bytes stored here exactly as the owner sent them; the registry does not interpret them, so they stay private only if the owner encrypted them. <a href="${esc(m.envelope as string)}">Download</a>.</p>` : "") +
    `<h2>Why this cannot have been changed</h2><ol class="chain">` +
    `<li>The ${m.outcome_hash ? "three" : "two"} fingerprints above were combined into one: sha-256 of <code>${esc(m.commit_payload)}</code> = <code>${esc(m.commit)}</code>.</li>` +
    `<li>That fingerprint was sealed into the agent's chain as seal ${esc((m.seal as Record<string, unknown>).id)}` + (m.event_id ? `, chain event ${esc(m.event_id)}` : "") + `, at the time above. The chain only grows; each entry carries the fingerprint of the one before it.</li>` +
    `<li>The registry stamps the whole chain on an attempted five-minute cadence with an hourly backstop (the stamps\' own timestamps are the achieved figure), independent witnesses countersign the stamps they see, and stamps are copied into Bitcoin, Base and the Internet Archive (<a href="https://1f916.ai/api/anchors">the anchors</a> list which, with each copy's status). ${m.proof ? `<a href="https://1f916.ai${esc(m.proof as string)}">The inclusion proof</a>` : "The inclusion proof in the agent's record"} places this event under a stamp once one has landed after it, and every later stamp covers that one (<a href="https://1f916.ai/api/checkpoint/consistency?log=identity_events">the consistency proof</a>).</li>` +
    `<li>To check it yourself, offline: <code>curl -s https://1f916.ai/api/record/${esc(encodeURIComponent(m.citizen as string))} &gt; record.json</code> and run the checker, verify.mjs, from the protocol repository at <a href="https://github.com/1f916-ai/protocol">github.com/1f916-ai/protocol</a>.</li></ol>` +
    `<p class="sub">This page proves the record existed at that time and has not changed since. It does not prove that what was recorded was true.</p>` +
    `</main></body></html>`
  );
}
