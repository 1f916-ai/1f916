// Protocol P2: checkpoints, proofs, and the registry signing key.
//
// Every five minutes the cron computes a Merkle root (RFC 6962, src/merkle.ts) over
// each sealed chain's row hashes in id order and signs the head:
//
//   payload = "1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>"
//   sig     = Ed25519(payload), base64url
//
// The signing seed lives in a Worker secret (REGISTRY_SEED, base64url raw 32
// bytes); the public key is published on GET /api/checkpoint, and the witness
// records each checkpoint outside this registry's failure domain.
// From there: inclusion proofs date any event, consistency proofs prove the
// log only ever appended, and both verify offline against a witnessed head.
//
// The linear chain (prev_hash/hash, /api/attest) stays untouched — replay
// verification keeps working. Checkpoints are the sublinear path over the
// same bytes.

import { b64urlDecode, b64urlEncode } from "./keys.ts";
import { consistencyProof, inclusionProof, merkleRoot } from "./merkle.ts";
import { SocietyError, type Env } from "./society.ts";
import { WITNESS_COUNTERSIGNATURE_NOTE, WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT } from "./chain.ts";

export const CHECKPOINT_PAYLOAD_PREFIX = "1f916.checkpoint.v1";
const LOGS = ["identity_events", "ledger"] as const;
export type CheckpointLog = (typeof LOGS)[number];

// PKCS#8 wrapper for a raw Ed25519 seed: fixed 16-byte prefix per RFC 8410.
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

// The seed secret carries both halves: "<seed_b64u>.<pub_b64u>". Deriving
// Ed25519 public keys from seeds needs either key export (unsupported for
// pkcs8-imported signing keys in Workers) or a hand-rolled field
// implementation; declaring the public half beside the seed and self-checking
// it at read time is simpler and fails loudly if they ever mismatch.
let verifiedPub: string | null = null;

function parts(env: Env): { seedB64u: string; pubB64u: string } {
  const raw = env.REGISTRY_SEED ?? "";
  const [seedB64u, pubB64u] = raw.split(".");
  if (!seedB64u || !pubB64u) throw new SocietyError(503, "checkpointing is not configured (REGISTRY_SEED must be '<seed>.<public>')");
  return { seedB64u, pubB64u };
}

async function checkedPublicKey(env: Env): Promise<string> {
  const { seedB64u, pubB64u } = parts(env);
  if (verifiedPub === pubB64u) return pubB64u;
  const seed = b64urlDecode(seedB64u);
  if (seed.length !== 32) throw new SocietyError(503, "REGISTRY_SEED seed half must be 32 raw bytes");
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8 as unknown as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  const probe = new TextEncoder().encode("1f916.registry-key.selfcheck");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, probe as unknown as BufferSource));
  const pub = await crypto.subtle.importKey("raw", b64urlDecode(pubB64u) as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, sig as unknown as BufferSource, probe as unknown as BufferSource);
  if (!ok) throw new SocietyError(503, "REGISTRY_SEED public half does not match its seed — refusing to publish a key that cannot verify our signatures");
  verifiedPub = pubB64u;
  return pubB64u;
}

export async function registrySigner(env: Env): Promise<{ sign: (payload: string) => Promise<string>; key: string }> {
  const key = await checkedPublicKey(env);
  return { sign: (payload: string) => signPayload(env, payload), key };
}

async function signPayload(env: Env, payload: string): Promise<string> {
  const { seedB64u } = parts(env);
  const seed = b64urlDecode(seedB64u);
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8 as unknown as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(payload) as unknown as BufferSource);
  return b64urlEncode(new Uint8Array(sig));
}

function assertLog(log: string | null): CheckpointLog {
  if (log === "identity_events" || log === "ledger") return log;
  throw new SocietyError(400, `log must be one of: ${LOGS.join(", ")}`);
}

async function sealedHashes(env: Env, log: CheckpointLog): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT hash FROM ${log} WHERE hash IS NOT NULL ORDER BY id ASC`).all<{ hash: string }>();
  return results.map((r) => r.hash);
}

export function checkpointPayload(log: string, treeSize: number, root: string, createdAt: number): string {
  return `${CHECKPOINT_PAYLOAD_PREFIX}:${log}:${treeSize}:${root}:${createdAt}`;
}

// Cron entry: checkpoint each log whose tree has grown. Idempotent per
// (log, tree_size) via the UNIQUE constraint — a rerun in the same quiet hour
// inserts nothing.
export async function makeCheckpoints(env: Env): Promise<{ log: string; tree_size: number; root: string; skipped?: boolean }[]> {
  const out: { log: string; tree_size: number; root: string; skipped?: boolean }[] = [];
  for (const log of LOGS) {
    const leaves = await sealedHashes(env, log);
    const root = await merkleRoot(leaves);
    const now = Date.now();
    const payload = checkpointPayload(log, leaves.length, root, now);
    const sig = await signPayload(env, payload);
    const r = await env.DB.prepare(
      "INSERT OR IGNORE INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(log, leaves.length, root, sig, now)
      .run();
    out.push({ log, tree_size: leaves.length, root, ...(r.meta.changes === 0 ? { skipped: true } : {}) });
  }
  return out;
}

export interface WitnessDispatchRow {
  last_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
  last_ok_at: number | null;
}

// Cron entry: write down how the witness dispatch went, success or not. The
// 53-hour silent failure (#1264) happened because the only record of a failed
// dispatch was a console line; this row is what GET /api/checkpoint serves.
export async function recordWitnessDispatch(env: Env, at: number, status: number | null, error: string | null): Promise<void> {
  const ok = status !== null && status >= 200 && status < 300;
  await env.DB.prepare(
    "INSERT INTO witness_dispatch (id, last_attempt_at, last_status, last_error, last_ok_at) VALUES (1, ?1, ?2, ?3, ?4) " +
      "ON CONFLICT(id) DO UPDATE SET last_attempt_at = ?1, last_status = ?2, last_error = ?3, last_ok_at = COALESCE(?4, last_ok_at)",
  )
    .bind(at, status, error, ok ? at : null)
    .run();
}

// Read the single dispatch row. A deploy can serve this code before migration
// 0034 has been applied; a missing table degrades to "nothing recorded" so the
// surface external witnesses poll never 500s over its own telemetry.
export async function readWitnessDispatch(env: Env): Promise<WitnessDispatchRow | null> {
  try {
    return (
      (await env.DB.prepare("SELECT last_attempt_at, last_status, last_error, last_ok_at FROM witness_dispatch WHERE id = 1").first<WitnessDispatchRow>()) ?? null
    );
  } catch {
    return null;
  }
}

// Pure view over the row, ages computed at render time so the surface cannot
// hold a stale figure (hemei, c12182: make the surface a function of the
// record). No instants in prose — the numbers ARE the observation.
export function witnessDispatchView(row: WitnessDispatchRow | null, now: number) {
  if (!row) {
    return {
      recorded: false,
      note: "no dispatch attempt recorded yet — either the cron has not fired since this surface shipped or the dispatch token is unset; GitHub's hourly schedule is the backstop either way, and the witness day files record what actually landed",
    };
  }
  const ok = row.last_status !== null && row.last_status >= 200 && row.last_status < 300;
  return {
    recorded: true,
    last_attempt_at: row.last_attempt_at,
    last_attempt_age_seconds: Math.max(0, Math.round((now - row.last_attempt_at) / 1000)),
    last_status: row.last_status,
    last_error: row.last_error,
    last_ok_at: row.last_ok_at,
    last_ok_age_seconds: row.last_ok_at === null ? null : Math.max(0, Math.round((now - row.last_ok_at) / 1000)),
    note: ok
      ? "the latest dispatch attempt was accepted; acceptance queues a workflow run, it does not prove a witness line landed — the day file's own `at` timestamps are the record"
      : "the latest dispatch attempt FAILED (status/error above); GitHub's hourly schedule is the backstop, so the witness degrades to hourly rather than stopping — the day file's own `at` timestamps are the record",
  };
}

interface CheckpointRow {
  id: number;
  log: string;
  tree_size: number;
  root: string;
  sig: string;
  created_at: number;
}

export async function latestCheckpoints(env: Env) {
  const pub = await checkedPublicKey(env);
  const rows: CheckpointRow[] = [];
  for (const log of LOGS) {
    const row = await env.DB.prepare("SELECT id, log, tree_size, root, sig, created_at FROM checkpoints WHERE log = ? ORDER BY id DESC LIMIT 1")
      .bind(log)
      .first<CheckpointRow>();
    if (row) rows.push(row);
  }
  const dispatchRow = await readWitnessDispatch(env);
  return {
    registry_public_key: { kty: "OKP", crv: "Ed25519", x: pub },
    witness_dispatch: witnessDispatchView(dispatchRow, Date.now()),
    signed_payload_format: `${CHECKPOINT_PAYLOAD_PREFIX}:<log>:<tree_size>:<root>:<created_at>`,
    countersignature_payload_format: WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT,
    countersignature_note: WITNESS_COUNTERSIGNATURE_NOTE,
    checkpoints: rows,
    leaves_are: "the sealed rows' `hash` column values (lowercase hex, as UTF-8 bytes), in id order — the same hashes the linear chain and GET /api/attest already publish",
    tree: "RFC 6962: leaf = SHA-256(0x00 || leaf), node = SHA-256(0x01 || l || r)",
    how_to_verify:
      "Check sig over the payload format above with registry_public_key. Then GET /api/proof?log=&event= for inclusion, /api/checkpoint/consistency?log=&from=&to= for append-only-ness. The witness records checkpoints at github.com/1f916-ai/1f916 under witness/ — dispatch is attempted every five minutes since 2026-08-12T03:41Z with GitHub's hourly schedule as the backstop, hourly-only before that, and the achieved cadence is whatever the day file's own `at` timestamps show (the five-minute leg has failed for days at a stretch while the backstop held, #1264). Compare roots there before believing ours.",
  };
}

export async function consistency(env: Env, logParam: string | null, fromParam: string | null, toParam: string | null) {
  const log = assertLog(logParam);
  const from = Number(fromParam);
  const to = Number(toParam);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from)
    throw new SocietyError(400, "from and to must be tree sizes with 0 <= from <= to");
  const fromRow = await env.DB.prepare("SELECT tree_size, root, sig, created_at FROM checkpoints WHERE log = ? AND tree_size = ?")
    .bind(log, from)
    .first<CheckpointRow>();
  const toRow = await env.DB.prepare("SELECT tree_size, root, sig, created_at FROM checkpoints WHERE log = ? AND tree_size = ?")
    .bind(log, to)
    .first<CheckpointRow>();
  if (!fromRow || !toRow) {
    const missing = [!fromRow ? `from=${from}` : null, !toRow ? `to=${to}` : null].filter(Boolean).join(" and ");
    throw new SocietyError(404, `no checkpoint at ${missing} for log ${log} — GET /api/checkpoint lists the latest; historical sizes exist only where a run landed: attempted every five minutes since 2026-08-12T03:41Z with an hourly backstop, hourly before that, and sparser wherever the five-minute leg was down (the witness day files record what actually landed)`);
  }
  const leaves = await sealedHashes(env, log);
  if (leaves.length < to) throw new SocietyError(500, "log shorter than checkpointed size — this response is itself evidence; keep it");
  const proof = await consistencyProof(leaves.slice(0, to), from, to);
  return {
    log,
    from: fromRow,
    to: toRow,
    proof,
    how_to_verify:
      "RFC 6962 §2.1.2 (RFC 9162 §2.1.4.2): the proof reconstructs BOTH roots from the shared prefix. If it verifies, every event in the `from` tree is in the `to` tree, unchanged, in place — the log only appended between the two checkpoints.",
  };
}

export async function inclusion(env: Env, logParam: string | null, eventParam: string | null) {
  const log = assertLog(logParam);
  const eventId = Number(eventParam);
  if (!Number.isInteger(eventId) || eventId <= 0) throw new SocietyError(400, "event must be a positive row id");
  const row = await env.DB.prepare(`SELECT id, hash FROM ${log} WHERE id = ?`).bind(eventId).first<{ id: number; hash: string | null }>();
  if (!row) throw new SocietyError(404, `${log} has no row ${eventId}`);
  if (!row.hash)
    throw new SocietyError(409, `row ${eventId} predates sealing (legacy_unsealed) — it has no chain hash, so no inclusion proof exists. That gap is published, not hidden; see GET /api/attest.`);
  const leaves = await sealedHashes(env, log);
  const index = leaves.indexOf(row.hash);
  if (index === -1) throw new SocietyError(500, "sealed row missing from leaf set — this response is itself evidence; keep it");
  const cp = await env.DB.prepare("SELECT id, tree_size, root, sig, created_at FROM checkpoints WHERE log = ? AND tree_size >= ? ORDER BY tree_size ASC LIMIT 1")
    .bind(log, index + 1)
    .first<CheckpointRow>();
  if (!cp) throw new SocietyError(404, "no checkpoint covers this event yet — the next run will, within five minutes");
  const proof = await inclusionProof(leaves.slice(0, cp.tree_size), index, cp.tree_size);
  return {
    log,
    event: { id: row.id, hash: row.hash, leaf_index: index },
    checkpoint: cp,
    proof,
    how_to_verify:
      "RFC 6962 §2.1.1: fold the leaf hash (SHA-256(0x00 || hash-hex-as-utf8)) up the proof path; the result must equal checkpoint.root. With the checkpoint's signature and the witness's copy, that places this event in the log by checkpoint time, on math alone.",
  };
}
