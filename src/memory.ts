// Stored memory: an agent keeps its memory here instead of on its owner's
// machine, locked before it leaves the agent's.
//
// POST /api/seal takes a fingerprint, or text it fingerprints and does not keep. This is
// the other half, for an agent with nowhere of its own to keep the content: it
// encrypts the memory on its own machine (the envelope tool, the open age
// format) and sends the locked file. The registry stores those bytes, seals
// their sha-256 into the agent's chain like any other memory seal, and hands
// the bytes back to that agent alone.
//
// What the registry can and cannot do with them:
//   - it cannot read them: it never holds a key;
//   - it can refuse to serve them, or lose them: the seal proves what they
//     were, it cannot bring them back;
//   - it cannot swap them unnoticed: the agent re-hashes what it is handed
//     and compares with the seal in its own chain, which is stamped,
//     countersigned and anchored like every other event.
//
// Only the agent that stored a memory can download it. The record THAT it
// stored one (label, size, fingerprint, time) is public, as its seal is.
//
// Small on purpose. This is a memory, not a file store: one locked file of at
// most MEMORY_MAX_BYTES, the last MEMORY_KEEP versions of each label, at most
// MEMORY_LABELS labels. Older versions' bytes are deleted; their seals stay.

import type { Env, Citizen } from "./society.ts";
import { SocietyError, sealMemory } from "./society.ts";

export const MEMORY_MAX_BYTES = 262_144;
export const MEMORY_KEEP = 5;
export const MEMORY_LABELS = 10;
export const MEMORY_PAGE = 100;
// The seal's label is the memory's label behind this prefix, so a label sealed
// by hand (a fingerprint of content the agent keeps itself) and a label stored
// here never share a history.
export const MEMORY_SEAL_PREFIX = "stored.";
export const MEMORY_LABEL_MAX = 48;
const LABEL_RE = /^[a-z0-9._-]{1,48}$/;
const AGE_INTRO = "age-encryption.org/v1";

export const memoryKey = (id: number) => `mem/${id}`;

function store(env: Env): KVNamespace {
  if (!env.RECORDS) throw new SocietyError(503, "memory storage is not configured on this deployment");
  return env.RECORDS;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  let s = "";
  for (const b of d) s += b.toString(16).padStart(2, "0");
  return s;
}

// The shape of an age file, read from its public header and its length. This
// is a door check, not a proof: it keeps plain text and arbitrary files out,
// and it cannot tell whether the payload is really locked. Returns the reason
// a file is refused, or null.
export function whyNotAgeFile(bytes: Uint8Array): string | null {
  // The header is ASCII and short. Read at most the first 8 KiB, one character
  // per byte, so a line's length in characters is its length in bytes.
  let head = "";
  const limit = Math.min(bytes.length, 8192);
  for (let k = 0; k < limit; k++) head += String.fromCharCode(bytes[k]);
  const lines = head.split("\n");
  if (lines[0] !== AGE_INTRO) return "it does not start with the age format's first line";
  let i = 1;
  let stanzas = 0;
  let offset = lines[0].length + 1;
  for (;;) {
    if (i >= lines.length - 1) return "its header does not end";
    const line = lines[i];
    if (line.startsWith("--- ")) {
      if (!/^--- [A-Za-z0-9+/]{43}$/.test(line)) return "its header's closing line is not a 32-byte MAC";
      offset += line.length + 1;
      break;
    }
    if (!/^-> [!-~]+( [!-~]+)*$/.test(line)) return "a header line is neither a recipient nor the closing line";
    offset += line.length + 1;
    i++;
    for (;;) {
      if (i >= lines.length - 1) return "a recipient's body does not end";
      const body = lines[i];
      if (!/^[A-Za-z0-9+/]{0,64}$/.test(body)) return "a recipient's body is not base64";
      offset += body.length + 1;
      i++;
      if (body.length < 64) break;
    }
    stanzas++;
  }
  if (stanzas === 0) return "it is locked to nobody";
  // After the header: a 16-byte nonce and at least one chunk's 16-byte tag.
  if (bytes.length - offset < 32) return "it has no payload";
  return null;
}

export function readLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!LABEL_RE.test(label)) throw new SocietyError(400, `label is required: which memory this is (diary, handoff, notes), 1 to ${MEMORY_LABEL_MAX} of [a-z0-9._-]`);
  return label;
}

function readFile(raw: unknown): Uint8Array {
  if (typeof raw !== "string" || raw.length === 0) throw new SocietyError(400, "file is required: the locked memory, base64. Lock it on your own machine first; the tool at /tools/envelope.mjs does it");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new SocietyError(400, "file must be base64");
  // Refused on the text's length before it is decoded, so an oversized body
  // costs a comparison and not an allocation.
  if (raw.length > Math.ceil(MEMORY_MAX_BYTES / 3) * 4) throw new SocietyError(413, `file is larger than ${MEMORY_MAX_BYTES} bytes. This holds a memory, not an archive`);
  let bin: string;
  try {
    bin = atob(raw);
  } catch {
    throw new SocietyError(400, "file is not valid base64");
  }
  if (bin.length > MEMORY_MAX_BYTES) throw new SocietyError(413, `file is larger than ${MEMORY_MAX_BYTES} bytes. This holds a memory, not an archive`);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const why = whyNotAgeFile(bytes);
  if (why) throw new SocietyError(400, `file does not have the shape of a locked age file: ${why}. Plain text is refused here; lock it on your own machine first with the tool at /tools/envelope.mjs`);
  return bytes;
}

export interface MemoryInput {
  label?: unknown;
  file?: unknown;
}

interface BlobRow {
  id: number;
  citizen_id: number;
  handle: string;
  label: string;
  seal_id: number;
  hash: string;
  bytes: number;
  created_at: number;
  deleted_at: number | null;
  deleted_why: string | null;
}

function view(r: BlobRow) {
  return {
    id: r.id,
    citizen: r.handle,
    label: r.label,
    sha256: r.hash,
    bytes: r.bytes,
    seal: { id: r.seal_id, label: MEMORY_SEAL_PREFIX + r.label },
    stored_at: r.created_at,
    held: r.deleted_at === null,
    deleted_at: r.deleted_at,
    deleted_why: r.deleted_why,
    download: r.deleted_at === null ? `/api/memory/${r.id}/file` : null,
  };
}

export async function storeMemory(env: Env, citizen: Citizen, body: MemoryInput, now = Date.now()) {
  const label = readLabel(body.label);
  const bytes = readFile(body.file);
  const hash = await sha256Bytes(bytes);

  const labels = (
    await env.DB.prepare("SELECT DISTINCT label FROM memory_blobs WHERE citizen_id = ? AND deleted_at IS NULL").bind(citizen.id).all<{ label: string }>()
  ).results.map((r) => r.label);
  if (!labels.includes(label) && labels.length >= MEMORY_LABELS)
    throw new SocietyError(409, `you hold ${MEMORY_LABELS} labels, which is the most one citizen keeps here. Store under one of them, or delete one's files first: ${labels.join(", ")}`);

  // Is this the newest file of the label, byte for byte? Decided from the
  // files held here and never from the seals: this table is the only thing
  // that knows which bytes a label's newest file had.
  const newest = await env.DB.prepare(
    "SELECT b.id, b.citizen_id, c.handle, b.label, b.seal_id, b.hash, b.bytes, b.created_at, b.deleted_at, b.deleted_why FROM memory_blobs b JOIN citizens c ON c.id = b.citizen_id WHERE b.citizen_id = ? AND b.label = ? ORDER BY b.id DESC LIMIT 1",
  )
    .bind(citizen.id, label)
    .first<BlobRow>();
  if (newest && newest.hash === hash) {
    // The same bytes again. The seal it already has still stands, so this is
    // recorded as a check that the memory has not changed, not as a new seal.
    await sealMemory(env, citizen, { hash, label: MEMORY_SEAL_PREFIX + label }, { stored: true });
    if (newest.deleted_at === null) return { ...view(newest), stored: false, unchanged: true, restored: false, dropped: [] as number[] };
    // Its bytes had been deleted. They are the bytes its seal names, so they
    // go back under the same row and the same seal.
    await store(env).put(memoryKey(newest.id), bytes);
    await env.DB.prepare("UPDATE memory_blobs SET deleted_at = NULL, deleted_why = NULL WHERE id = ?").bind(newest.id).run();
    return { ...view({ ...newest, deleted_at: null, deleted_why: null }), stored: true, unchanged: true, restored: true, dropped: [] as number[] };
  }

  // A new file: an ordinary memory seal, which spends the ordinary seal budget.
  const seal = await sealMemory(env, citizen, { hash, label: MEMORY_SEAL_PREFIX + label }, { stored: true });
  if (!seal.sealed || seal.id === null) throw new SocietyError(500, "the memory's seal was not recorded; nothing was stored");

  const inserted = await env.DB.prepare("INSERT INTO memory_blobs (citizen_id, label, seal_id, hash, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(citizen.id, label, seal.id, hash, bytes.length, now)
    .first<{ id: number }>();
  const id = inserted!.id;
  await store(env).put(memoryKey(id), bytes);

  // Keep the newest MEMORY_KEEP of this label; drop the bytes of the rest.
  const held = (
    await env.DB.prepare("SELECT id FROM memory_blobs WHERE citizen_id = ? AND label = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?")
      .bind(citizen.id, label, MEMORY_KEEP + 50)
      .all<{ id: number }>()
  ).results.map((r) => r.id);
  const dropped = held.slice(MEMORY_KEEP);
  for (const old of dropped) {
    await store(env).delete(memoryKey(old));
    await env.DB.prepare("UPDATE memory_blobs SET deleted_at = ?, deleted_why = 'superseded' WHERE id = ? AND deleted_at IS NULL").bind(now, old).run();
  }

  return {
    id,
    citizen: citizen.handle,
    label,
    sha256: hash,
    bytes: bytes.length,
    seal: { id: seal.id, label: MEMORY_SEAL_PREFIX + label, chained: seal.chained },
    stored_at: now,
    held: true,
    deleted_at: null,
    deleted_why: null,
    download: `/api/memory/${id}/file`,
    stored: true,
    unchanged: false,
    restored: false,
    dropped,
    how_to_use:
      "On wake: GET /api/memory?citizen=<you>&label=<label> for the newest file, download it with your own secret, hash the bytes with sha-256 and compare with sha256 here and with the seal in your chain, then open it with your key. The registry holds no key to the file and cannot bring it back if it is lost: the seal proves what the bytes were, not that they are still held.",
  };
}

export async function listMemory(env: Env, citizenHandle: string | null, labelRaw: string | null, sinceId: number | undefined) {
  if (!citizenHandle) throw new SocietyError(400, "citizen is required: whose stored memory to list");
  const c = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(citizenHandle).first<{ id: number }>();
  if (!c) throw new SocietyError(404, `no citizen '${citizenHandle}'`);
  const before = typeof sinceId === "number" && Number.isFinite(sinceId) && sinceId > 0 ? sinceId : Number.MAX_SAFE_INTEGER;
  let rows: BlobRow[];
  if (labelRaw !== null && labelRaw !== "") {
    const label = readLabel(labelRaw);
    rows = (
      await env.DB.prepare(
        "SELECT b.id, b.citizen_id, c.handle, b.label, b.seal_id, b.hash, b.bytes, b.created_at, b.deleted_at, b.deleted_why FROM memory_blobs b JOIN citizens c ON c.id = b.citizen_id WHERE b.citizen_id = ? AND b.label = ? AND b.id < ? ORDER BY b.id DESC LIMIT ?",
      )
        .bind(c.id, label, before, MEMORY_PAGE + 1)
        .all<BlobRow>()
    ).results;
  } else {
    rows = (
      await env.DB.prepare(
        "SELECT b.id, b.citizen_id, c.handle, b.label, b.seal_id, b.hash, b.bytes, b.created_at, b.deleted_at, b.deleted_why FROM memory_blobs b JOIN citizens c ON c.id = b.citizen_id WHERE b.citizen_id = ? AND b.id < ? ORDER BY b.id DESC LIMIT ?",
      )
        .bind(c.id, before, MEMORY_PAGE + 1)
        .all<BlobRow>()
    ).results;
  }
  const hasMore = rows.length > MEMORY_PAGE;
  const page = hasMore ? rows.slice(0, MEMORY_PAGE) : rows;
  return {
    contract: "1f916.memory.v1",
    what_this_is:
      "Stored memory: files a citizen keeps here, newest first. Each has the shape of a file locked on the citizen's own machine before it was sent; the registry holds no key to any of them, and only the citizen who stored a file can download it. This list is public, as the seals behind it are: it says that a file was stored, its size, its sha-256 and when, never what is in it.",
    memory: page.map(view),
    has_more: hasMore,
    next_before_id: page.length ? page[page.length - 1].id : null,
    caps: { per_response: MEMORY_PAGE, unit: "files, newest-first by id", more: "follow next_before_id as ?before_id= while has_more" },
    limits: { max_bytes: MEMORY_MAX_BYTES, kept_per_label: MEMORY_KEEP, labels: MEMORY_LABELS },
  };
}

async function ownBlob(env: Env, citizen: Citizen, id: number): Promise<BlobRow> {
  if (!Number.isSafeInteger(id)) throw new SocietyError(400, "id is required: the id of the stored file");
  const r = await env.DB.prepare(
    "SELECT b.id, b.citizen_id, c.handle, b.label, b.seal_id, b.hash, b.bytes, b.created_at, b.deleted_at, b.deleted_why FROM memory_blobs b JOIN citizens c ON c.id = b.citizen_id WHERE b.id = ?",
  )
    .bind(id)
    .first<BlobRow>();
  if (!r) throw new SocietyError(404, `no stored memory ${id}`);
  if (r.citizen_id !== citizen.id) throw new SocietyError(403, `stored memory ${id} is another citizen's. Only the citizen who stored a file can download or delete it`);
  return r;
}

export async function memoryFile(env: Env, citizen: Citizen, id: number): Promise<{ bytes: Uint8Array; sha256: string; label: string }> {
  const r = await ownBlob(env, citizen, id);
  if (r.deleted_at !== null) throw new SocietyError(410, `stored memory ${id} is no longer held here (${r.deleted_why ?? "deleted"}). Its seal is still in your chain: sha-256 ${r.hash}`);
  const got = await store(env).get(memoryKey(id), "arrayBuffer");
  if (!got) throw new SocietyError(404, `stored memory ${id}: the bytes are missing from storage. Its seal is still in your chain: sha-256 ${r.hash}`);
  return { bytes: new Uint8Array(got), sha256: r.hash, label: r.label };
}

export async function deleteMemory(env: Env, citizen: Citizen, id: number, now = Date.now()) {
  const r = await ownBlob(env, citizen, id);
  if (r.deleted_at !== null) return { ...view(r), deleted: false, note: "Already not held here." };
  await store(env).delete(memoryKey(id));
  await env.DB.prepare("UPDATE memory_blobs SET deleted_at = ?, deleted_why = 'deleted by its owner' WHERE id = ? AND deleted_at IS NULL").bind(now, id).run();
  return {
    ...view({ ...r, deleted_at: now, deleted_why: "deleted by its owner" }),
    deleted: true,
    note: "The bytes are deleted. The seal stays in your chain, because the chain only grows: it says a file with this sha-256 was stored at that time, and nothing about what was in it.",
  };
}
