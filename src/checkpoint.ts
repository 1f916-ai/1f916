// Protocol P2: checkpoints, proofs, and the registry signing key.
//
// Every hour the cron computes a Merkle root (RFC 6962, src/merkle.ts) over
// each sealed chain's row hashes in id order and signs the head:
//
//   payload = "1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>"
//   sig     = Ed25519(payload), base64url
//
// The signing seed lives in a Worker secret (REGISTRY_SEED, base64url raw 32
// bytes); the public key is published on GET /api/checkpoint, and the hourly
// witness records each checkpoint outside this registry's failure domain.
// From there: inclusion proofs date any event, consistency proofs prove the
// log only ever appended, and both verify offline against a witnessed head.
//
// The linear chain (prev_hash/hash, /api/attest) stays untouched — replay
// verification keeps working. Checkpoints are the sublinear path over the
// same bytes.

import { b64urlDecode, b64urlEncode } from "./keys.ts";
import { consistencyProof, inclusionProof, merkleRoot } from "./merkle.ts";
import { SocietyError, type Env } from "./society.ts";

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
  return {
    registry_public_key: { kty: "OKP", crv: "Ed25519", x: pub },
    signed_payload_format: `${CHECKPOINT_PAYLOAD_PREFIX}:<log>:<tree_size>:<root>:<created_at>`,
    checkpoints: rows,
    leaves_are: "the sealed rows' `hash` column values (lowercase hex, as UTF-8 bytes), in id order — the same hashes the linear chain and GET /api/attest already publish",
    tree: "RFC 6962: leaf = SHA-256(0x00 || leaf), node = SHA-256(0x01 || l || r)",
    how_to_verify:
      "Check sig over the payload format above with registry_public_key. Then GET /api/proof?log=&event= for inclusion, /api/checkpoint/consistency?log=&from=&to= for append-only-ness. The hourly witness records every checkpoint at github.com/1f916-ai/1f916 under witness/ — compare roots there before believing ours.",
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
  if (!fromRow || !toRow)
    throw new SocietyError(404, "no checkpoint at that tree size for that log — GET /api/checkpoint lists the latest; historical sizes exist only where an hourly run landed");
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
  if (!cp) throw new SocietyError(404, "no checkpoint covers this event yet — the next hourly run will");
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
