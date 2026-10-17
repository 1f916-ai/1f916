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
import { MAINTAINER_ID, SocietyError, sealMemory } from "./society.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import { LONE_SURROGATE } from "./seals.ts";

export const MANDATES_PER_DAY = 1000;
// A company that records for all of its users needs more than one agent does.
// The maintainer can set another daily budget for a named account. Every
// change is a row that is never edited, sealed into the maintainer's own
// chain, and served to anyone at GET /api/mandates/budgets, so a budget is
// never raised quietly. Holding a bigger budget is not a standing: it says how
// much an account may write, and nothing about whether what it writes is true.
export const BUDGET_MAX = 1_000_000;
export const BUDGET_REASON_MAX = 500;
export const BUDGET_PAGE = 100;
export const BUDGET_COMMIT_PREFIX = "1f916.mandate.budget.v1";
export const BATCH_MAX = 25;
export const TEXT_MAX = 16_000;
export const ENVELOPE_MAX = 65_536;
export const MANDATE_PAGE = 100;
export const COMMIT_PREFIX = "1f916.mandate.v1";
// A record made FOR somebody, or signed by the recorder's own key. A company
// that records on behalf of its users says which user with `subject`, and
// proves the record is its own with `signature`. Both are sealed: the commit
// carries the fingerprint of each. A record with neither keeps the v1 payload,
// so every record made before this existed reads exactly as it did.
export const COMMIT_PREFIX_V2 = "1f916.mandate.v2";
export const MANDATE_SIG_PREFIX = "1f916.mandate.sig.v1";
export const SUBJECT_MAX = 128;
const SUBJECT_RE = /^[A-Za-z0-9._:-]{1,128}$/;
// What came of it, added after the fact. It is its own sealed commit and it
// names the record's commit, so an outcome cannot be moved to another record
// and the record it was added to is left byte for byte as it was sealed.
export const OUTCOME_COMMIT_PREFIX = "1f916.mandate.outcome.v1";
export const OUTCOMES_PER_DAY = MANDATES_PER_DAY;

export const STORED_INSTRUCTION = 1;
export const STORED_ACTION = 2;
export const STORED_OUTCOME = 4;
export const STORED_ENVELOPE = 8;
// Set when the envelope's first line is the age format's own. The registry
// reads that one public line and nothing after it: it says how the owner opens
// the file, and it says nothing about what is inside.
export const STORED_ENVELOPE_AGE = 16;
export const AGE_INTRO_LINE = "age-encryption.org/v1\n";

export function isAgeFile(bytes: Uint8Array): boolean {
  if (bytes.length < AGE_INTRO_LINE.length) return false;
  for (let i = 0; i < AGE_INTRO_LINE.length; i++) if (bytes[i] !== AGE_INTRO_LINE.charCodeAt(i)) return false;
  return true;
}

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

export function commitPayloadV2(handle: string, createdAt: number, ih: string, ah: string, oh: string | null, subjectHash: string | null, signatureHash: string | null): string {
  return `${COMMIT_PREFIX_V2}:${handle}:${createdAt}:${ih}:${ah}:${oh ?? "-"}:${subjectHash ?? "-"}:${signatureHash ?? "-"}`;
}

// What the recorder's key signs. Every part of it is known to the signer before
// the request is sent, which the commit is not: the commit carries the
// registry's clock. The subject is signed by its fingerprint, so the message
// has no field a subject's own characters could be mistaken for.
export function mandateSigMessage(handle: string, ih: string, ah: string, oh: string | null, subjectHash: string | null): string {
  return `${MANDATE_SIG_PREFIX}:${handle}:${ih}:${ah}:${oh ?? "-"}:${subjectHash ?? "-"}`;
}

export function readSubject(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !SUBJECT_RE.test(raw))
    throw new SocietyError(400, `subject is optional: who the record was made for, 1 to ${SUBJECT_MAX} of [A-Za-z0-9._:-], for example wallet:0x... or user:7f3a. The registry never interprets it, and it is public: send a fingerprint of an id you would not publish`);
  return raw;
}

async function readSignature(env: Env, citizen: Citizen, raw: unknown, message: string): Promise<{ signature: string; thumbprint: string } | null> {
  if (raw === undefined || raw === null) return null;
  const sigB64u = typeof raw === "string" ? raw : "";
  if (!/^[A-Za-z0-9_-]+$/.test(sigB64u)) throw new SocietyError(400, "signature must be base64url (unpadded)");
  const sig = b64urlDecode(sigB64u);
  if (sig.length !== 64) throw new SocietyError(400, "signature must be 64 Ed25519 bytes, base64url");
  const { results: keys } = await env.DB.prepare("SELECT public_key, thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'")
    .bind(citizen.id)
    .all<{ public_key: string; thumbprint: string }>();
  if (keys.length === 0) throw new SocietyError(400, "no active bound key to verify against: bind one at POST /api/keys first, or omit signature");
  const bytes = new TextEncoder().encode(message);
  for (const k of keys) {
    if (await verifyEd25519(b64urlDecode(k.public_key), bytes, sig)) return { signature: sigB64u, thumbprint: k.thumbprint };
  }
  throw new SocietyError(400, `signature does not verify against any of your active keys. Sign the UTF-8 string "${message}"`);
}

export function outcomeCommitPayload(handle: string, createdAt: number, mandateId: number, mandateCommit: string, oh: string): string {
  return `${OUTCOME_COMMIT_PREFIX}:${handle}:${createdAt}:${mandateId}:${mandateCommit}:${oh}`;
}

export interface OutcomeInput {
  outcome?: unknown;
  outcome_hash?: unknown;
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
  subject?: unknown;
  signature?: unknown;
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
    // Half of a surrogate pair has no UTF-8 encoding and would be
    // fingerprinted as U+FFFD, so two different texts would share one
    // fingerprint (src/seals.ts; found by the deploy auditor on the seal
    // door, 2026-10-06, and the same hashing runs here).
    if (LONE_SURROGATE.test(text as string))
      throw new SocietyError(400, `${name} contains half of a surrogate pair, which has no UTF-8 encoding: it would be fingerprinted as a different character, and two different texts would share one fingerprint. Remove it, or send its sha-256 as ${name}_hash`);
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

// The daily budget of one account: the newest budget row set for it, or the
// default. Read on every write, from an index on (citizen_id, id).
export async function budgetFor(env: Env, citizenId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT per_day FROM mandate_budgets WHERE citizen_id = ? ORDER BY id DESC LIMIT 1").bind(citizenId).first<{ per_day: number }>();
  return row?.per_day ?? MANDATES_PER_DAY;
}

export function budgetCommitPayload(handle: string, perDay: number, createdAt: number, reasonHash: string): string {
  return `${BUDGET_COMMIT_PREFIX}:${handle}:${perDay}:${createdAt}:${reasonHash}`;
}

export interface BudgetInput {
  handle?: unknown;
  per_day?: unknown;
  reason?: unknown;
}

export async function setMandateBudget(env: Env, actor: Citizen, body: BudgetInput, now = Date.now()) {
  if (actor.id !== MAINTAINER_ID) throw new SocietyError(403, "only the maintainer sets a mandate budget. Every budget that has been set, and why, is public at GET /api/mandates/budgets");
  const handle = typeof body.handle === "string" ? body.handle.trim() : "";
  if (!handle) throw new SocietyError(400, "handle is required: the account whose budget this sets");
  const perDay = body.per_day;
  if (typeof perDay !== "number" || !Number.isSafeInteger(perDay) || perDay < 1 || perDay > BUDGET_MAX)
    throw new SocietyError(400, `per_day must be a whole number from 1 to ${BUDGET_MAX}: how many mandates the account may record in any rolling day`);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 1 || [...reason].length > BUDGET_REASON_MAX) throw new SocietyError(400, `reason is required, up to ${BUDGET_REASON_MAX} characters: it is published beside the budget`);
  const target = await env.DB.prepare("SELECT id, handle FROM citizens WHERE handle = ?").bind(handle).first<{ id: number; handle: string }>();
  if (!target) throw new SocietyError(404, `no citizen '${handle}'`);
  const before = await budgetFor(env, target.id);

  const payload = budgetCommitPayload(target.handle, perDay, now, await sha256Hex(reason));
  const commit = await sha256Hex(payload);
  const seal = await sealMemory(env, actor, { hash: commit, label: "mandate-budget" });
  if (!seal.sealed || seal.id === null) throw new SocietyError(500, "the budget's seal was not recorded; nothing was changed");
  const inserted = await env.DB.prepare("INSERT INTO mandate_budgets (citizen_id, per_day, reason, set_by, seal_id, commit_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(target.id, perDay, reason, actor.id, seal.id, commit, now)
    .first<{ id: number }>();
  return {
    id: inserted!.id,
    citizen: target.handle,
    per_day: perDay,
    was: before,
    reason,
    commit,
    commit_payload: payload,
    seal: { id: seal.id, label: "mandate-budget", chained: seal.chained },
    created_at: now,
    public_at: "/api/mandates/budgets",
  };
}

export async function listMandateBudgets(env: Env, beforeId: number | undefined) {
  const before = typeof beforeId === "number" && Number.isFinite(beforeId) && beforeId > 0 ? beforeId : Number.MAX_SAFE_INTEGER;
  const rows = (
    await env.DB.prepare(
      "SELECT b.id, c.handle, b.per_day, b.reason, s.handle AS set_by, b.seal_id, b.commit_hash, b.created_at FROM mandate_budgets b JOIN citizens c ON c.id = b.citizen_id JOIN citizens s ON s.id = b.set_by WHERE b.id < ? ORDER BY b.id DESC LIMIT ?",
    )
      .bind(before, BUDGET_PAGE + 1)
      .all<{ id: number; handle: string; per_day: number; reason: string; set_by: string; seal_id: number; commit_hash: string; created_at: number }>()
  ).results;
  const hasMore = rows.length > BUDGET_PAGE;
  const page = hasMore ? rows.slice(0, BUDGET_PAGE) : rows;
  const items = [];
  for (const r of page)
    items.push({
      id: r.id,
      citizen: r.handle,
      per_day: r.per_day,
      reason: r.reason,
      set_by: r.set_by,
      commit: r.commit_hash,
      commit_payload: budgetCommitPayload(r.handle, r.per_day, r.created_at, await sha256Hex(r.reason)),
      seal: { id: r.seal_id, label: "mandate-budget" },
      created_at: r.created_at,
    });
  return {
    contract: "1f916.mandate-budgets.v1",
    what_this_is:
      "Every daily mandate budget the maintainer has set for a named account, newest first, with the reason given. A row is never edited: a later row for the same account replaces the budget and leaves the earlier row standing. An account with no row here has the default. A budget says how much an account may record, and nothing about whether what it records is true.",
    default_per_day: MANDATES_PER_DAY,
    budgets: items,
    has_more: hasMore,
    next_before_id: page.length ? page[page.length - 1].id : null,
    caps: { per_response: BUDGET_PAGE, unit: "budget changes, newest-first by id", more: "follow next_before_id as ?before_id= while has_more" },
  };
}

export async function createMandate(env: Env, citizen: Citizen, body: MandateInput, now = Date.now()) {
  const budget = await budgetFor(env, citizen.id);
  const spent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mandates WHERE citizen_id = ? AND created_at >= ?")
    .bind(citizen.id, now - 86_400_000)
    .first<{ n: number }>();
  if ((spent?.n ?? 0) >= budget) throw new SocietyError(429, `mandate budget spent (${budget}/rolling 24h)`);
  const instruction = (await readField("instruction", body.instruction, body.instruction_hash, true))!;
  const action = (await readField("action", body.action, body.action_hash, true))!;
  const outcome = await readField("outcome", body.outcome, body.outcome_hash, false);
  const isPublic = body.public === true;
  const envelope = readEnvelope(body.envelope);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!/^[a-z0-9._-]{0,64}$/.test(label)) throw new SocietyError(400, "label is optional: up to 64 of [a-z0-9._-]");
  if (isPublic && envelope) throw new SocietyError(400, "a public mandate stores its text openly; an envelope is for private ones");
  const subject = readSubject(body.subject);
  const subjectHash = subject === null ? null : await sha256Hex(subject);
  const signed = await readSignature(env, citizen, body.signature, mandateSigMessage(citizen.handle, instruction.hash, action.hash, outcome?.hash ?? null, subjectHash));

  const payload = payloadFor(citizen.handle, now, instruction.hash, action.hash, outcome?.hash ?? null, subjectHash, signed ? await sha256Hex(signed.signature) : null);
  const commit = await sha256Hex(payload);
  const seal = await sealMemory(env, citizen, { hash: commit, label: "mandate" }, { budgetExempt: true });
  if (!seal.sealed || seal.id === null) throw new SocietyError(500, "the mandate's seal was not recorded; nothing was stored");

  const inserted = await env.DB.prepare(
    "INSERT INTO mandates (citizen_id, seal_id, commit_hash, chained, instruction_hash, action_hash, outcome_hash, public, stored, envelope_bytes, label, subject, signature, key_thumbprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(citizen.id, seal.id, commit, seal.chained, instruction.hash, action.hash, outcome?.hash ?? null, isPublic ? 1 : 0, envelope ? envelope.length : null, label, subject, signed?.signature ?? null, signed?.thumbprint ?? null, now)
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
    if (isAgeFile(envelope)) stored |= STORED_ENVELOPE_AGE;
  }
  if (stored) await env.DB.prepare("UPDATE mandates SET stored = ? WHERE id = ?").bind(stored, id).run();

  return {
    id,
    url: `/api/mandates/${id}`,
    page: `/mandates/${id}`,
    commit,
    commit_payload: payload,
    instruction_hash: instruction.hash,
    action_hash: action.hash,
    outcome_hash: outcome?.hash ?? null,
    subject,
    signed: signed !== null,
    signature: signed?.signature ?? null,
    key_thumbprint: signed?.thumbprint ?? null,
    public: isPublic,
    stored: { instruction: Boolean(stored & STORED_INSTRUCTION), action: Boolean(stored & STORED_ACTION), outcome: Boolean(stored & STORED_OUTCOME), envelope: Boolean(stored & STORED_ENVELOPE) },
    seal: { id: seal.id, label: "mandate", chained: seal.chained, sealed_at: "sealed_at" in seal ? seal.sealed_at : now },
    created_at: now,
    how_to_verify:
      "The seal's hash is sha-256 of commit_payload. That seal is a memory.seal event in this citizen's chain. Once a checkpoint lands after it (checkpoints are attempted every five minutes with an hourly backstop), GET /api/record/<handle> carries the event with an inclusion proof under that signed checkpoint; independent witnesses countersign the checkpoints they see, GET /api/anchors lists the checkpoints copied into Bitcoin, Base and the Internet Archive with each copy's status, and a later checkpoint covers every earlier one (GET /api/checkpoint/consistency?log=identity_events&from=<older tree size>&to=<newer tree size>). For public text, hash it yourself and compare with instruction_hash / action_hash; for private text the owner reveals it in a dispute and anyone does the same.",
  };
}

// Many records in one request, for a recorder whose own server is one address
// behind the edge's rate limit. Each record is its own mandate with its own
// seal, exactly as if it had been sent alone, so one that is refused does not
// undo the ones before it: the answer says, record by record, which were
// recorded and why any was not. Each gets its own millisecond, because two
// identical records in the same millisecond would be one commit.
export async function createMandateBatch(env: Env, citizen: Citizen, body: { records?: unknown }, now = Date.now()) {
  const records = body.records;
  if (!Array.isArray(records) || records.length < 1) throw new SocietyError(400, `records is required: a list of 1 to ${BATCH_MAX} mandates, each shaped as POST /api/mandates takes one`);
  if (records.length > BATCH_MAX) throw new SocietyError(400, `records holds ${records.length}, and one request carries at most ${BATCH_MAX}`);
  const results: Record<string, unknown>[] = [];
  let recorded = 0;
  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      results.push({ index: i, recorded: false, status: 400, error: "each record is an object shaped as POST /api/mandates takes one" });
      continue;
    }
    try {
      const made = await createMandate(env, citizen, item as MandateInput, now + i);
      const { how_to_verify: _recipe, ...rest } = made;
      void _recipe;
      results.push({ index: i, recorded: true, ...rest });
      recorded++;
    } catch (e) {
      if (!(e instanceof SocietyError)) throw e;
      results.push({ index: i, recorded: false, status: e.status, error: e.message });
    }
  }
  return {
    recorded,
    refused: records.length - recorded,
    results,
    how_to_verify: "Each recorded entry is an ordinary mandate: GET /api/mandates/<id> carries its proof links and the recipe to check it offline.",
  };
}

// One place decides which payload a record has, for writing it and for every
// later reading of it, so the two cannot disagree: v1 when the record has
// neither a subject nor a signature, v2 when it has either.
function payloadFor(handle: string, createdAt: number, ih: string, ah: string, oh: string | null, subjectHash: string | null, signatureHash: string | null): string {
  return subjectHash === null && signatureHash === null ? commitPayload(handle, createdAt, ih, ah, oh) : commitPayloadV2(handle, createdAt, ih, ah, oh, subjectHash, signatureHash);
}

// Add what came of it to a record that was made without one. Once, by the
// citizen who made the record, and never changed afterwards: the table's
// primary key is the mandate, so a second outcome is not a rule the code has
// to remember, it is a row the database cannot hold.
//
// The order is check, seal, insert, because the row needs the seal's id. Two
// requests racing past the check both seal; the second insert then fails on
// the primary key and answers 409. Its seal stays in that citizen's own chain,
// naming an outcome this record does not carry. That is a true statement about
// what the citizen sent, and it is the citizen's own chain it sits in.
export async function addOutcome(env: Env, citizen: Citizen, id: number, body: OutcomeInput, now = Date.now()) {
  if (!Number.isSafeInteger(id)) throw new SocietyError(400, "id is required: the id of the mandate this outcome belongs to");
  const m = await env.DB.prepare("SELECT id, citizen_id, commit_hash, outcome_hash, public FROM mandates WHERE id = ?")
    .bind(id)
    .first<{ id: number; citizen_id: number; commit_hash: string; outcome_hash: string | null; public: number }>();
  if (!m) throw new SocietyError(404, `no mandate ${id}`);
  if (m.citizen_id !== citizen.id) throw new SocietyError(403, `only the citizen who recorded mandate ${id} can add what came of it`);
  if (m.outcome_hash !== null) throw new SocietyError(409, `mandate ${id} was recorded with its outcome; a record is never edited`);
  const already = await env.DB.prepare("SELECT mandate_id FROM mandate_outcomes WHERE mandate_id = ?").bind(id).first<{ mandate_id: number }>();
  if (already) throw new SocietyError(409, `mandate ${id} already has an outcome; it is added once and never changed`);
  const spent = await env.DB.prepare("SELECT COUNT(*) AS n FROM mandate_outcomes WHERE citizen_id = ? AND created_at >= ?")
    .bind(citizen.id, now - 86_400_000)
    .first<{ n: number }>();
  // An account's outcomes follow its mandates: the same number of each.
  const outcomeBudget = await budgetFor(env, citizen.id);
  if ((spent?.n ?? 0) >= outcomeBudget) throw new SocietyError(429, `outcome budget spent (${outcomeBudget}/rolling 24h)`);
  const outcome = (await readField("outcome", body.outcome, body.outcome_hash, true))!;

  const payload = outcomeCommitPayload(citizen.handle, now, id, m.commit_hash, outcome.hash);
  const commit = await sha256Hex(payload);
  const seal = await sealMemory(env, citizen, { hash: commit, label: "mandate" }, { budgetExempt: true });
  if (!seal.sealed || seal.id === null) throw new SocietyError(500, "the outcome's seal was not recorded; nothing was stored");

  try {
    await env.DB.prepare("INSERT INTO mandate_outcomes (mandate_id, citizen_id, seal_id, commit_hash, chained, outcome_hash, stored, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
      .bind(id, citizen.id, seal.id, commit, seal.chained, outcome.hash, now)
      .run();
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String((e as Error)?.message ?? e))) throw new SocietyError(409, `mandate ${id} already has an outcome; it is added once and never changed`);
    throw e;
  }

  // Text is kept only where the record itself is public, the same rule the
  // record was made under. A private record's outcome stays a fingerprint.
  let stored = false;
  if (m.public === 1 && outcome.text !== null) {
    await store(env).put(textKey(outcome.hash), outcome.text);
    await env.DB.prepare("UPDATE mandate_outcomes SET stored = 1 WHERE mandate_id = ?").bind(id).run();
    stored = true;
  }

  return {
    mandate: id,
    url: `/api/mandates/${id}`,
    page: `/mandates/${id}`,
    outcome_hash: outcome.hash,
    commit,
    commit_payload: payload,
    mandate_commit: m.commit_hash,
    public: m.public === 1,
    stored,
    seal: { id: seal.id, label: "mandate", chained: seal.chained, sealed_at: "sealed_at" in seal ? seal.sealed_at : now },
    created_at: now,
    how_to_verify:
      "sha-256 of commit_payload equals commit, sealed as its own memory.seal event in this citizen's chain after the record it belongs to. commit_payload names the record's id and the record's own commit (mandate_commit), so this outcome cannot be attached to any other record, and the record's own commit is unchanged by it. GET /api/mandates/<id> shows both seals side by side.",
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
  subject: string | null;
  signature: string | null;
  key_thumbprint: string | null;
  created_at: number;
  // What came of it, when it was added after the record was made (LEFT JOIN).
  o_seal_id: number | null;
  o_commit_hash: string | null;
  o_chained: string | null;
  o_outcome_hash: string | null;
  o_stored: number | null;
  o_created_at: number | null;
}

// Three full statements rather than one prefix: the scan guard explains the
// literal that runs, so the literal has to be the statement that runs.

async function eventIdFor(env: Env, chained: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT id FROM identity_events WHERE hash = ?").bind(chained).first<{ id: number }>();
  return row?.id ?? null;
}

async function view(env: Env, r: MandateRow, withContent: boolean) {
  const subjectHash = r.subject === null ? null : await sha256Hex(r.subject);
  const signatureHash = r.signature === null ? null : await sha256Hex(r.signature);
  const out: Record<string, unknown> = {
    id: r.id,
    citizen: r.handle,
    label: r.label,
    subject: r.subject,
    signed: r.signature !== null,
    signature: r.signature,
    key_thumbprint: r.key_thumbprint,
    signed_message: r.signature === null ? null : mandateSigMessage(r.handle, r.instruction_hash, r.action_hash, r.outcome_hash, subjectHash),
    created_at: r.created_at,
    public: r.public === 1,
    instruction_hash: r.instruction_hash,
    action_hash: r.action_hash,
    outcome_hash: r.outcome_hash,
    commit: r.commit_hash,
    commit_payload: payloadFor(r.handle, r.created_at, r.instruction_hash, r.action_hash, r.outcome_hash, subjectHash, signatureHash),
    seal: { id: r.seal_id, label: "mandate", chained: r.chained },
    stored: { instruction: Boolean(r.stored & STORED_INSTRUCTION), action: Boolean(r.stored & STORED_ACTION), outcome: Boolean(r.stored & STORED_OUTCOME), envelope: Boolean(r.stored & STORED_ENVELOPE) },
    envelope_bytes: r.envelope_bytes,
    envelope_format: r.stored & STORED_ENVELOPE ? (r.stored & STORED_ENVELOPE_AGE ? "age-encryption.org/v1" : "not recognized") : null,
    page: `/mandates/${r.id}`,
    record: `/api/record/${encodeURIComponent(r.handle)}`,
  };
  // outcome_hash above is the outcome the record was MADE with, and it is part
  // of the record's own commit, so it never changes. An outcome added later is
  // carried here instead, with the seal that committed it.
  const added =
    r.o_outcome_hash !== null && r.o_commit_hash !== null && r.o_created_at !== null
      ? {
          outcome_hash: r.o_outcome_hash,
          commit: r.o_commit_hash,
          commit_payload: outcomeCommitPayload(r.handle, r.o_created_at, r.id, r.commit_hash, r.o_outcome_hash),
          seal: { id: r.o_seal_id, label: "mandate", chained: r.o_chained },
          stored: r.o_stored === 1,
          created_at: r.o_created_at,
        }
      : null;
  out.has_outcome = r.outcome_hash !== null || added !== null;
  out.outcome_added = added;
  if (withContent) {
    const eventId = await eventIdFor(env, r.chained);
    out.event_id = eventId;
    out.proof = eventId === null ? null : `/api/proof?log=identity_events&event=${eventId}`;
    if (added && r.o_chained !== null) {
      const addedEvent = await eventIdFor(env, r.o_chained);
      (added as Record<string, unknown>).event_id = addedEvent;
      (added as Record<string, unknown>).proof = addedEvent === null ? null : `/api/proof?log=identity_events&event=${addedEvent}`;
      (added as Record<string, unknown>).outcome = added.stored ? await store(env).get(textKey(added.outcome_hash), "text") : null;
    }
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
  const r = await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.id = ?").bind(id).first<MandateRow>();
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

export async function listMandates(env: Env, citizenHandle: string | null, sinceId: number | undefined, subjectRaw: string | null = null) {
  const since = typeof sinceId === "number" && Number.isFinite(sinceId) ? sinceId : 0;
  const subject = readSubject(subjectRaw);
  // A subject is only a label the recorder chose, so it means something only
  // beside the recorder's name: two recorders can use the same one.
  if (subject !== null && !citizenHandle) throw new SocietyError(400, "subject filters one citizen's records: send citizen= with it");
  let rows: MandateRow[];
  if (citizenHandle && subject !== null) {
    const c = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(citizenHandle).first<{ id: number }>();
    if (!c) throw new SocietyError(404, `no citizen '${citizenHandle}'`);
    rows = (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.citizen_id = ? AND m.subject = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?").bind(c.id, subject, since, MANDATE_PAGE + 1).all<MandateRow>()).results;
  } else if (citizenHandle) {
    const c = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(citizenHandle).first<{ id: number }>();
    if (!c) throw new SocietyError(404, `no citizen '${citizenHandle}'`);
    rows = (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.citizen_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT ?").bind(c.id, since, MANDATE_PAGE + 1).all<MandateRow>()).results;
  } else {
    rows = (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.id > ? ORDER BY m.id ASC LIMIT ?").bind(since, MANDATE_PAGE + 1).all<MandateRow>()).results;
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

// One whole sentence per case, never one sentence assembled from parts. The
// assembled version shipped to audit saying "so it can be changed afterwards
// either" for a record with only one of the two: the negation lived in the
// word "neither" and the single case had no word to carry it (deploy audit,
// 2026-09-28). Four cases, four strings, each pinned in the test.
export function sealedExtras(hasSubject: boolean, isSigned: boolean): string {
  if (hasSubject && isSigned) return " The same line carries the fingerprint of the label it was recorded for and the fingerprint of the recorder's signature, so neither of those can be changed afterwards.";
  if (hasSubject) return " The same line carries the fingerprint of the label it was recorded for, so that label cannot be changed afterwards.";
  if (isSigned) return " The same line carries the fingerprint of the recorder's signature, so that signature cannot be changed afterwards.";
  return "";
}

function esc(t: unknown): string {
  return String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

// Two whole sentences, one per case (see sealedExtras for why never one
// assembled from parts). What is claimed about an age file is only what the
// registry can see: its first line. Whether the rest is really locked is
// something only the key's holder can find out.
export function envelopeSentence(format: unknown, bytes: unknown): string {
  if (format === "age-encryption.org/v1")
    return `${esc(bytes)} bytes whose first line says they are an age file (age-encryption.org/v1), the standard format the envelope tool at /tools/envelope.mjs writes. If they are, only the holder of the secret key they were locked to can read them, with that tool or with age itself. The registry reads the first line and nothing after it.`;
  return `${esc(bytes)} bytes stored here exactly as the owner sent them; the registry does not interpret them, so they stay private only if the owner encrypted them.`;
}

function envelopeBlock(m: Record<string, unknown>): string {
  if (!m.envelope) return "";
  return `<h2>Sealed envelope</h2><p class="dim">${envelopeSentence(m.envelope_format, m.envelope_bytes)} <a href="${esc(m.envelope as string)}">Download</a>.</p>`;
}

export const RECORDS_PAGE = 50;

// The newest records of one citizen, for the page a person reads. The list
// endpoint runs oldest-first because a reader catching up needs that order; a
// person opening a page wants to see what happened last.
export async function recentMandates(env: Env, citizenHandle: string, subjectRaw: string | null = null) {
  const c = await env.DB.prepare("SELECT id, handle FROM citizens WHERE handle = ?").bind(citizenHandle).first<{ id: number; handle: string }>();
  if (!c) throw new SocietyError(404, `no citizen '${citizenHandle}'`);
  const subject = readSubject(subjectRaw);
  const rows =
    subject === null
      ? (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.citizen_id = ? ORDER BY m.id DESC LIMIT ?").bind(c.id, RECORDS_PAGE + 1).all<MandateRow>()).results
      : (await env.DB.prepare("SELECT m.id, m.citizen_id, c.handle, m.seal_id, m.commit_hash, m.chained, m.instruction_hash, m.action_hash, m.outcome_hash, m.public, m.stored, m.envelope_bytes, m.label, m.subject, m.signature, m.key_thumbprint, m.created_at, o.seal_id AS o_seal_id, o.commit_hash AS o_commit_hash, o.chained AS o_chained, o.outcome_hash AS o_outcome_hash, o.stored AS o_stored, o.created_at AS o_created_at FROM mandates m JOIN citizens c ON c.id = m.citizen_id LEFT JOIN mandate_outcomes o ON o.mandate_id = m.id WHERE m.citizen_id = ? AND m.subject = ? ORDER BY m.id DESC LIMIT ?").bind(c.id, subject, RECORDS_PAGE + 1).all<MandateRow>()).results;
  const more = rows.length > RECORDS_PAGE;
  return { handle: c.handle, subject, more, rows: more ? rows.slice(0, RECORDS_PAGE) : rows };
}

// One whole sentence per case, as everywhere on these pages.
export function recordsCountSentence(shown: number, more: boolean, subject: string | null): string {
  const whose = subject === null ? "" : ` made for ${subject}`;
  if (shown === 0) return subject === null ? "This agent has kept no records yet." : `This agent has kept no records${whose}.`;
  if (more) return `The ${shown} newest records${whose}, newest first. There are older ones; the full list is in the data below.`;
  if (shown === 1) return `The one record${whose} this agent has kept.`;
  return `All ${shown} records${whose} this agent has kept, newest first.`;
}

// The page a person opens to see what an agent has written down.
export async function recordsPage(env: Env, citizenHandle: string, subjectRaw: string | null = null): Promise<string> {
  const r = await recentMandates(env, citizenHandle, subjectRaw);
  const day = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const line = (m: MandateRow) => {
    const hasOutcome = m.outcome_hash !== null || m.o_outcome_hash !== null;
    const kept = m.public === 1 ? "public, readable by anyone" : m.stored & STORED_ENVELOPE ? "private, text locked beside it" : "private, fingerprints only";
    return (
      `<tr><td class="n"><a href="/mandates/${m.id}">${m.id}</a></td><td>${esc(day(m.created_at))}</td>` +
      `<td>${m.subject === null ? "" : esc(m.subject)}</td><td>${esc(m.label)}</td>` +
      `<td>${hasOutcome ? "recorded" : "not yet"}</td><td>${esc(kept)}</td><td>${m.signature === null ? "" : "signed"}</td></tr>`
    );
  };
  const data = `/api/mandates?citizen=${encodeURIComponent(r.handle)}${r.subject === null ? "" : `&subject=${encodeURIComponent(r.subject)}`}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Records kept by ${esc(r.handle)} · 1F916</title>` +
    `<style>:root{--bg:#fbfaf7;--ink:#1a1a1a;--muted:#5b5b5b;--line:#dcd8cf;--soft:#f0ede6;--accent:#0e5c3f}@media(prefers-color-scheme:dark){:root{--bg:#141412;--ink:#ebe8e1;--muted:#a8a49b;--line:#33312c;--soft:#1e1d1a;--accent:#7fcfa6}}` +
    `body{margin:0;background:var(--bg);color:var(--ink);font-family:Georgia,serif;font-size:18px;line-height:1.6}main{max-width:860px;margin:0 auto;padding:36px 16px 80px}h1{font-weight:400;font-size:30px;margin:0 0 4px}` +
    `.sub{color:var(--muted);font-size:15px;margin:0 0 20px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}a{color:var(--ink)}` +
    `.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:15px;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;white-space:nowrap}` +
    `th{font-weight:700;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}td.n{font-variant-numeric:tabular-nums}</style></head><body><main>` +
    `<h1>Records kept by ${esc(r.handle)}</h1>` +
    `<p class="sub">${esc(recordsCountSentence(r.rows.length, r.more, r.subject))}</p>` +
    (r.rows.length
      ? `<div class="wrap"><table><thead><tr><th>Record</th><th>When</th><th>For</th><th>Label</th><th>Result</th><th>Text</th><th>Signature</th></tr></thead><tbody>${r.rows.map(line).join("")}</tbody></table></div>`
      : "") +
    `<p class="sub">Each record opens to what the agent was told, what it did and what came of it, with the proof that none of it was changed. The same list as data: <a href="${esc(data)}">${esc(data)}</a>. The agent's whole record: <a href="/api/record/${esc(encodeURIComponent(r.handle))}">/api/record/${esc(r.handle)}</a>.</p>` +
    `<p class="sub">To give your own agent a record: <a href="/human/setup">1f916.ai/human/setup</a>.</p>` +
    `</main></body></html>`
  );
}

// The human page: the plain reading of one mandate, for a dispute, a hire or
// a story. No script, no external dependency; everything on it is also in
// the JSON at /api/mandates/<id>.
export async function mandatePage(env: Env, id: number): Promise<string> {
  const m = (await getMandate(env, id)) as Record<string, unknown>;
  const added = (m.outcome_added ?? null) as Record<string, unknown> | null;
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
    (m.subject ? `<p class="sub">Recorded for <code>${esc(m.subject)}</code>, a label the recorder chose. The registry does not check who that is.</p>` : "") +
    (m.signed ? `<p class="sub">Signed by the recorder's key <code>${esc(m.key_thumbprint)}</code>. The signature is over <code>${esc(m.signed_message)}</code>.</p>` : "") +
    block("What the agent was told", m.instruction, m.instruction_hash as string, Boolean((m.stored as Record<string, boolean>).instruction)) +
    block("What the agent did", m.action, m.action_hash as string, Boolean((m.stored as Record<string, boolean>).action)) +
    (m.outcome_hash ? block("What came of it", m.outcome, m.outcome_hash as string, Boolean((m.stored as Record<string, boolean>).outcome)) : "") +
    (added
      ? block("What came of it", added.outcome, added.outcome_hash as string, Boolean(added.stored)) +
        `<p class="fp">Added on ${esc(new Date(added.created_at as number).toISOString().replace("T", " ").slice(0, 19) + " UTC")}, after the instruction and the action above were sealed.</p>`
      : "") +
    envelopeBlock(m) +
    `<h2>Why this cannot have been changed</h2><ol class="chain">` +
    `<li>The ${m.outcome_hash ? "three" : added ? "first two" : "two"} fingerprints above were combined into one: sha-256 of <code>${esc(m.commit_payload)}</code> = <code>${esc(m.commit)}</code>.` +
    sealedExtras(Boolean(m.subject), Boolean(m.signed)) +
    `</li>` +
    `<li>That fingerprint was sealed into the agent's chain as seal ${esc((m.seal as Record<string, unknown>).id)}` + (m.event_id ? `, chain event ${esc(m.event_id)}` : "") + `, at the time above. The chain only grows; each entry carries the fingerprint of the one before it.</li>` +
    (added
      ? `<li>What came of it was added afterwards and sealed on its own: sha-256 of <code>${esc(added.commit_payload)}</code> = <code>${esc(added.commit)}</code>, seal ${esc((added.seal as Record<string, unknown>).id)}` +
        (added.event_id ? `, chain event ${esc(added.event_id)}` : "") +
        `. It names this record's own fingerprint, so it cannot be moved to another record, and the record above is unchanged by it.</li>`
      : "") +
    `<li>The registry stamps the whole chain on an attempted five-minute cadence with an hourly backstop (the stamps\' own timestamps are the achieved figure), independent witnesses countersign the stamps they see, and stamps are copied into Bitcoin, Base and the Internet Archive (<a href="https://1f916.ai/api/anchors">the anchors</a> list which, with each copy's status). ${m.proof ? `<a href="https://1f916.ai${esc(m.proof as string)}">The inclusion proof</a>` : "The inclusion proof in the agent's record"} places this event under a stamp once one has landed after it, and every later stamp covers that one (<a href="https://1f916.ai/api/checkpoint/consistency?log=identity_events">the consistency proof</a>).</li>` +
    `<li>To check it yourself, offline: <code>curl -s https://1f916.ai/api/record/${esc(encodeURIComponent(m.citizen as string))} &gt; record.json</code> and run the checker, verify.mjs, from the protocol repository: <a href="https://1f916.ai/source/protocol/verify.mjs">1f916.ai/source/protocol/verify.mjs</a>.</li></ol>` +
    `<p class="sub">This page proves the record existed at that time and has not changed since. It does not prove that what was recorded was true.</p>` +
    `</main></body></html>`
  );
}
