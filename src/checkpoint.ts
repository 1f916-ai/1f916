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
// records each checkpoint outside this registry's failure domain. Each row
// records the key_epoch that signed it; the payload does not change, so every
// head signed before epochs existed verifies exactly as it did, under epoch 0
// (src/registry-keys.ts has the rotation).
// From there: inclusion proofs date any event, consistency proofs prove the
// log only ever appended, and both verify offline against a witnessed head.
//
// The linear chain (prev_hash/hash, /api/attest) stays untouched — replay
// verification keeps working. Checkpoints are the sublinear path over the
// same bytes.

import { b64urlDecode } from "./keys.ts";
import { consistencyProof, inclusionProof, merkleRoot } from "./merkle.ts";
import { SocietyError, type Env } from "./society.ts";
import { WITNESS_COUNTERSIGNATURE_NOTE, WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT } from "./chain.ts";
import { NOTE_KEY_NAME, checkpointBody, noteFromField, noteKeyId, originOf, signatureField, verifierKey } from "./note.ts";
import { WITNESS_CADENCE, WITNESS_STANDING, WITNESS_TRIGGER_NEVER_NOTE, WITNESS_TRIGGER_RETIRED_NOTE } from "./witness-cadence.ts";
import { cosignaturesFor, witnessView } from "./witness-network.ts";
import {
  activeRegistryKey,
  ensureEpochZero,
  historyView,
  readRegistryKeyHistory,
  REGISTRY_KEY_HISTORY_NOTE,
  REGISTRY_ROTATE_FORMAT,
  type RegistryKeyHistory,
  type RegistryKeyRow,
  type FinalHead,
  parseFinalHeads,
  isMissingKeyEpochColumn,
  isMissingRegistryKeysTable,
  withKeyEpoch,
} from "./registry-keys.ts";

export const CHECKPOINT_PAYLOAD_PREFIX = "1f916.checkpoint.v1";
const LOGS = ["identity_events", "ledger"] as const;
export type CheckpointLog = (typeof LOGS)[number];

// The key itself (which epoch, which secret holds it, how it rotates) lives in
// src/registry-keys.ts. This module asks it for the active signer and serves
// the history beside the heads it explains.
export async function registrySigner(env: Env): Promise<{ sign: (payload: string) => Promise<string>; key: string; epoch: number }> {
  const active = await activeRegistryKey(env);
  return { sign: active.sign, key: active.key, epoch: active.epoch };
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
  await ensureEpochZero(env);
  const signer = await activeRegistryKey(env);
  for (const log of LOGS) {
    const leaves = await sealedHashes(env, log);
    const root = await merkleRoot(leaves);
    // Never dated before the signing epoch began: a clock behind the instant
    // the rotation chose would otherwise date a new-key head inside the old
    // key's window, where verifiers look for the old key.
    const now = Math.max(Date.now(), signer.activated_at);
    const payload = checkpointPayload(log, leaves.length, root, now);
    const sig = await signer.sign(payload);
    // Written only while the key that signed it is still the active one. A
    // rotation that commits between the read above and this insert retires
    // that key at an instant before `now`, and a head signed by a retired key
    // after its retirement is exactly what a verifier must refuse; so the pass
    // writes nothing for this log and the next one signs with the new key.
    let r: { meta: { changes: number } };
    try {
      r = await env.DB.prepare(
        "INSERT OR IGNORE INTO checkpoints (log, tree_size, root, sig, created_at, key_epoch) SELECT ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT MAX(epoch) FROM registry_keys), 0) = ?",
      )
        .bind(log, leaves.length, root, sig, now, signer.epoch, signer.epoch)
        .run();
    } catch (e) {
      // Code before migration 0078: no key_epoch column and no registry_keys,
      // so there is only epoch 0 and the insert is the one it always was.
      if (signer.epoch !== 0 || !(isMissingKeyEpochColumn(e) || isMissingRegistryKeysTable(e))) throw e;
      r = await env.DB.prepare("INSERT OR IGNORE INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(log, leaves.length, root, sig, now)
        .run();
    }
    out.push({ log, tree_size: leaves.length, root, ...(r.meta.changes === 0 ? { skipped: true } : {}) });
    // The stamp above is written. The note only adds to it, so a failure here
    // is logged and never costs the stamp.
    await signNoteFor(env, log, leaves.length, signer).catch((e) => console.error(`checkpoint: note not signed for ${log} at ${leaves.length}: ${String(e)}`));
  }
  return out;
}

// The stamp, signed a second time in the format the certificate logs use
// (src/note.ts). This is the ONLY place a note is signed: by the stamping job,
// on its schedule, for the stamp at the size the log has now. A reader's
// request never reaches the key; it is served what was stored here.
//
// What is signed is the STORED row, not what this run computed, so a note can
// never state a size or a root that the stamp beside it does not. The stamp's
// row is never written: the note goes in its own table, once.
async function signNoteFor(env: Env, log: CheckpointLog, treeSize: number, signer: { epoch: number; key: string; sign: (payload: string) => Promise<string> }): Promise<void> {
  const row = await withKeyEpoch((epochCol) =>
    env.DB.prepare(
      `SELECT c.id, c.tree_size, c.root${epochCol === ", key_epoch" ? ", c.key_epoch" : epochCol}, n.signature FROM checkpoints c LEFT JOIN checkpoint_notes n ON n.checkpoint_id = c.id WHERE c.log = ? AND c.tree_size = ?`,
    )
      .bind(log, treeSize)
      .first<{ id: number; tree_size: number; root: string; key_epoch: number; signature: string | null }>(),
  );
  if (!row || row.signature !== null) return;
  // A note is signed by the key that signed its stamp (the note's key id names
  // that key). The job holds only the active key, so a stamp left from an
  // earlier epoch gets no note rather than one signed by a different key.
  if (row.key_epoch !== signer.epoch) return;
  const body = checkpointBody(originOf(log), row.tree_size, row.root);
  const field = signatureField(await noteKeyId(NOTE_KEY_NAME, b64urlDecode(signer.key)), b64urlDecode(await signer.sign(body)));
  await env.DB.prepare("INSERT OR IGNORE INTO checkpoint_notes (checkpoint_id, signature, created_at) VALUES (?, ?, ?)").bind(row.id, field, Date.now()).run();
}

export interface WitnessDispatchRow {
  last_attempt_at: number;
  last_status: number | null;
  last_error: string | null;
  last_ok_at: number | null;
}

// The row the registry's own trigger wrote, one attempt over the last. The
// trigger was removed on 2026-09-29 (src/witness-cadence.ts), so nothing
// writes this row any more; it is read as history.
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
// record). The row no longer moves, so the ages only grow, and `retired` says
// why: a reader who alarms on a growing age is told in a field, not in prose,
// that this is the end of the trigger and not an outage of it.
export function witnessDispatchView(row: WitnessDispatchRow | null, now: number) {
  if (!row) return { recorded: false, retired: true, note: WITNESS_TRIGGER_NEVER_NOTE };
  return {
    recorded: true,
    retired: true,
    last_attempt_at: row.last_attempt_at,
    last_attempt_age_seconds: Math.max(0, Math.round((now - row.last_attempt_at) / 1000)),
    last_status: row.last_status,
    last_error: row.last_error,
    last_ok_at: row.last_ok_at,
    last_ok_age_seconds: row.last_ok_at === null ? null : Math.max(0, Math.round((now - row.last_ok_at) / 1000)),
    note: WITNESS_TRIGGER_RETIRED_NOTE,
  };
}

const SEQUENCE_UNREAD_NOTE =
  "sqlite_sequence has no readable entry for the checkpoints table on this deployment (the read was refused, or nothing has ever been written); fall back to comparing checkpoints[].id across two reads, remembering that on a quiet log it does not move until the next written row";

const SEQUENCE_NOTE =
  "head is the checkpoints table's AUTOINCREMENT sequence. Every execution of the checkpoint step consumes attempts_per_pass values (one INSERT OR IGNORE per log), written or ignored, so head advances on a quiet log where checkpoints[].id and created_at do not. Δhead / attempts_per_pass is the number of executions between two reads, whoever ran them: the cron (attempted_pass_cron) or a manual crank (POST /api/checkpoint, maintainer only), which consumes the same values and is recorded nowhere a reader can see. So over one cron interval a Δhead of attempts_per_pass proves the step ran once, not that the cron ran it, and a crank inside the interval can stand in for a slot that never fired: measured against Δt / the cron interval, an excess is cranks, a shortfall is missed or failed passes, and only the shortfall is provable from here. Nothing served here proves the handler ran when this step did not. Until 2026-09-29 witness_dispatch.last_attempt_at did, being written by a later leg of the same handler; that leg was removed (witness_dispatch.retired) and the field will not move again, so it says nothing about any pass after it. A frozen head therefore reads one way only. Δhead 0 over a cron interval: this step consumed nothing, because the handler did not run, or it ran and the step's first leg threw before its insert, or the step was never entered (REGISTRY_SEED unset), and these cannot be told apart from here. Δhead of attempts_per_pass − 1: the first leg wrote or ignored and the next threw before its insert (there is no per-leg try, so the execution ends there).";

// wrangler.jsonc triggers.crons, the ATTEMPTED cadence of the checkpoint
// step; test/checkpoint-sequence-head.test.ts refuses a drift between the two.
// The achieved cadence is the sequence head, never this string.
export const CHECKPOINT_CRON = "*/5 * * * *";

interface SequenceRow {
  seq: number;
}

interface IdRow {
  id: number;
}

const SEQUENCE_SQL = "SELECT seq FROM sqlite_sequence WHERE name = 'checkpoints'";

// The checkpoints table's AUTOINCREMENT sequence head. makeCheckpoints tries
// one INSERT OR IGNORE per log every pass, and SQLite charges the sequence for
// an ignored insert exactly as for a written one (the test file beside this
// change shows it), so this number moves by LOGS.length per checkpointer pass
// whether or not any tree grew, while the served checkpoints[].id and
// created_at freeze on a quiet log (ORDER BY id DESC LIMIT 1 returns the last
// WRITTEN row). It is the checkpointer's own liveness signal, and since
// 2026-09-29 the only one served: witness_dispatch.last_attempt_at used to
// prove the handler ran even when this step threw, and the leg that wrote it
// was removed with the witness trigger. D1 may refuse a read of
// sqlite_sequence; degrade to null rather than 500 the endpoint, as
// readWitnessDispatch does.
export async function readCheckpointSequenceHead(env: Env): Promise<number | null> {
  try {
    const row = await env.DB.prepare(SEQUENCE_SQL).first<SequenceRow>();
    return row && Number.isInteger(row.seq) ? row.seq : null;
  } catch {
    return null;
  }
}

// Pure view over the sequence head and the served rows, so every reader gets
// the same arithmetic: head minus the newest written id is the count of
// ignored inserts since the last written row, and a pass is LOGS.length
// inserts. Ages are not computed here on purpose: the sequence has no clock,
// which is the point — compare two reads of head, not head against now.
export function checkpointSequenceView(head: number | null, rows: IdRow[]) {
  if (head === null) return { recorded: false, attempted_pass_cron: CHECKPOINT_CRON, note: SEQUENCE_UNREAD_NOTE };
  const newestWritten = rows.reduce((m, r) => Math.max(m, r.id), 0);
  const ignored = Math.max(0, head - newestWritten);
  return {
    recorded: true,
    head,
    attempts_per_pass: LOGS.length,
    attempted_pass_cron: CHECKPOINT_CRON,
    newest_written_id: newestWritten,
    ignored_since_newest_written: ignored,
    passes_since_newest_written: Math.floor(ignored / LOGS.length),
    note: SEQUENCE_NOTE,
  };
}

interface CheckpointRow {
  id: number;
  log: string;
  tree_size: number;
  root: string;
  sig: string;
  created_at: number;
  key_epoch: number;
}

export async function latestCheckpoints(env: Env) {
  const history = await readRegistryKeyHistory(env);
  const active = history.rows[history.rows.length - 1];
  const rows: CheckpointRow[] = [];
  for (const log of LOGS) {
    const row = await withKeyEpoch((epochCol) =>
      env.DB.prepare(`SELECT id, log, tree_size, root, sig, created_at${epochCol} FROM checkpoints WHERE log = ? ORDER BY id DESC LIMIT 1`)
        .bind(log)
        .first<CheckpointRow>(),
    );
    if (row) rows.push(row);
  }
  const sequenceHead = await readCheckpointSequenceHead(env);
  const dispatchRow = await readWitnessDispatch(env);
  // Independent witnesses' cosignatures of these stamps (src/witness-network.ts).
  // Absent, not empty, when no witness is configured, so an unconfigured
  // deployment serves exactly what it did before. Only configured witnesses'
  // lines are served.
  const witnesses = await witnessView(env, rows);
  return {
    contract: CHECKPOINT_PAYLOAD_PREFIX,
    // The ACTIVE key, as before: a client that reads only this field keeps
    // working until a rotation, and a rotation is announced in the history.
    registry_public_key: { kty: "OKP", crv: "Ed25519", x: active.public_key },
    registry_key_epoch: active.epoch,
    registry_key_history: historyView(history.rows),
    registry_key_history_recorded: history.recorded,
    registry_key_history_has_more: history.has_more,
    rotation_statement_format: REGISTRY_ROTATE_FORMAT,
    registry_key_note: REGISTRY_KEY_HISTORY_NOTE,
    witness_dispatch: witnessDispatchView(dispatchRow, Date.now()),
    signed_payload_format: `${CHECKPOINT_PAYLOAD_PREFIX}:<log>:<tree_size>:<root>:<created_at>`,
    countersignature_payload_format: WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT,
    countersignature_note: WITNESS_COUNTERSIGNATURE_NOTE,
    checkpoints: rows,
    note: await noteFacts(env, history),
    checkpoint_sequence: checkpointSequenceView(sequenceHead, rows),
    leaves_are: "the sealed rows' `hash` column values (lowercase hex, as UTF-8 bytes), in id order — the same hashes the linear chain and GET /api/attest already publish",
    tree: "RFC 6962: leaf = SHA-256(0x00 || leaf), node = SHA-256(0x01 || l || r)",
    how_to_verify:
      "Check sig over the payload format above with the key of the row's key_epoch in registry_key_history (registry_public_key is the active one; a head signed before a rotation names the older epoch). Then GET /api/proof?log=&event= for inclusion, /api/checkpoint/consistency?log=&from=&to= for append-only-ness. The witness records checkpoints at github.com/1f916-ai/1f916 under witness/. " +
      `${WITNESS_CADENCE}. ${WITNESS_STANDING}. ` +
      "The achieved cadence is whatever the day file's own `at` timestamps show (the dispatch attempt failed for days at a stretch while GitHub's own schedule held, #1264). Compare roots there before believing ours.",
    ...(witnesses ?? {}),
  };
}

// One stamp, said again in the format the certificate logs use (src/note.ts).
// It states nothing the stamp did not already state: the log, the size and the
// root are read from the stored row, and the signature beside them was made by
// the stamping job (signNoteFor) and stored. Nothing is signed here, and no key
// is read here. The stamp's own time is not in the note, because the format
// has no line for it; it stays in the stamp at GET /api/checkpoint.
export function noNoteSentence(log: string, treeSize: number): string {
  return `the stamp at tree_size=${treeSize} for log ${log} has no note. A note is written by the stamping job, never on request; the stamp itself is at GET /api/checkpoint`;
}

export async function checkpointNote(env: Env, logParam: string | null, sizeParam: number | undefined): Promise<string> {
  const log = assertLog(logParam);
  const wanted = typeof sizeParam === "number" && Number.isFinite(sizeParam) ? sizeParam : null;
  type NoteRow = { id: number; tree_size: number; root: string; signature: string | null };
  const row =
    wanted === null
      ? await env.DB.prepare("SELECT c.id, c.tree_size, c.root, n.signature FROM checkpoints c LEFT JOIN checkpoint_notes n ON n.checkpoint_id = c.id WHERE c.log = ? ORDER BY c.id DESC LIMIT 1").bind(log).first<NoteRow>()
      : await env.DB.prepare("SELECT c.id, c.tree_size, c.root, n.signature FROM checkpoints c LEFT JOIN checkpoint_notes n ON n.checkpoint_id = c.id WHERE c.log = ? AND c.tree_size = ?").bind(log, wanted).first<NoteRow>();
  if (!row) throw new SocietyError(404, wanted === null ? `no checkpoint yet for log ${log}` : `no checkpoint at tree_size=${wanted} for log ${log}; a note exists only for a size a stamp landed on`);
  if (row.signature === null) throw new SocietyError(404, noNoteSentence(log, row.tree_size));
  const note = noteFromField(checkpointBody(originOf(log), row.tree_size, row.root), NOTE_KEY_NAME, row.signature);
  // Witnesses' cosignatures follow the registry's line, as C2SP tlog-cosignature
  // lays them out: more signature lines on the same note. Each was verified
  // against its witness's key before it was kept, and is served only while
  // that witness is still configured (src/witness-network.ts).
  const cosigned = await cosignaturesFor(env, row.id);
  return note + cosigned.map((c) => c.line + "\n").join("");
}

export async function noteFacts(env: Env, history?: RegistryKeyHistory) {
  const h = history ?? (await readRegistryKeyHistory(env));
  const active = h.rows[h.rows.length - 1];
  return {
    format: "A signed note whose text is a checkpoint, as the transparency logs publish them (C2SP signed-note and tlog-checkpoint): origin, tree size, base64 root, a blank line, then the signature line.",
    key_name: NOTE_KEY_NAME,
    verifier_key: await verifierKey(NOTE_KEY_NAME, b64urlDecode(active.public_key)),
    // One verifier key per registry key epoch, oldest first. A note's key id
    // names the key that signed it, so a note made before a rotation verifies
    // under its own epoch's verifier key here; the rotation statement that
    // links the two keys is in registry_key_history.
    verifier_keys: await Promise.all(h.rows.map(async (r) => ({ key_epoch: r.epoch, verifier_key: await verifierKey(NOTE_KEY_NAME, b64urlDecode(r.public_key)) }))),
    origins: Object.fromEntries(LOGS.map((l) => [l, originOf(l)])),
    url: "/api/checkpoint/note/<log>",
    same_key: "A note is signed by the same registry key as its stamp (the key of the stamp's key_epoch), over that stamp's own log, size and root. verifier_key is the active epoch's; verifier_keys has every epoch's, and the key id on a note's signature line says which one signed it.",
    cosignatures: "When independent witnesses are configured, each one's verified cosignature/v1 line (C2SP tlog-cosignature) follows the registry's signature line, one line per witness. A verifier that pins only the registry key ignores them, as the signed-note format says; one that pins a witness's key (GET /api/checkpoint, cosigning_witnesses) checks it.",
    signed_when: "By the stamping job when it runs, for the stamp at the size the log has then. Never on a reader's request: the endpoint serves what was stored. A stamp that was already behind the log when notes began has none.",
  };
}

// The key history served beside a proof, so the proof file alone tells a
// verifier which key checks its head (a head from before a rotation names the
// older epoch). The proof routes never needed a key, so a key configuration
// problem (no key, or a malformed one, with nothing recorded yet: a 503 from
// the history read) omits the history rather than failing the proof. A
// database failure is not a configuration problem and is thrown.
async function historyRowsBesideProof(env: Env): Promise<RegistryKeyRow[] | null> {
  try {
    return (await readRegistryKeyHistory(env)).rows;
  } catch (e) {
    if (e instanceof SocietyError && e.status === 503) return null;
    throw e;
  }
}
async function historyBesideProof(env: Env): Promise<{ registry_key_history?: ReturnType<typeof historyView> }> {
  const rows = await historyRowsBesideProof(env);
  return rows ? { registry_key_history: historyView(rows) } : {};
}

export async function consistency(env: Env, logParam: string | null, fromParam: string | null, toParam: string | null) {
  const log = assertLog(logParam);
  const from = Number(fromParam);
  const to = Number(toParam);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from)
    throw new SocietyError(400, "from and to must be tree sizes with 0 <= from <= to");
  const sized = (size: number) =>
    withKeyEpoch((epochCol) =>
      env.DB.prepare(`SELECT tree_size, root, sig, created_at${epochCol} FROM checkpoints WHERE log = ? AND tree_size = ?`)
        .bind(log, size)
        .first<CheckpointRow>(),
    );
  const fromRow = await sized(from);
  const toRow = await sized(to);
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
    ...(await historyBesideProof(env)),
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
  const cp = await withKeyEpoch((epochCol) =>
    env.DB.prepare(`SELECT id, tree_size, root, sig, created_at${epochCol} FROM checkpoints WHERE log = ? AND tree_size >= ? ORDER BY tree_size ASC LIMIT 1`)
      .bind(log, index + 1)
      .first<CheckpointRow>(),
  );
  if (!cp) throw new SocietyError(404, "no checkpoint covers this event yet — a later run will. Runs are attempted every five minutes with an hourly backstop and the five-minute leg has been down for stretches (#1264), so the achieved cadence is whatever the witness day files record, not a five-minute guarantee");
  const proof = await inclusionProof(leaves.slice(0, cp.tree_size), index, cp.tree_size);
  // The smallest head covering an old event may be one a key since retired
  // signed, below the final head that key's rotation committed to. A verifier
  // accepts such a head only linked to that final head, so the link is served
  // here: the consistency proof from this head to the committed one.
  const rows = await historyRowsBesideProof(env);
  let finalConsistency: { log: string; from: { tree_size: number; root: string }; to: FinalHead; proof: string[] } | undefined;
  if (rows) {
    const key = rows.find((r) => r.epoch === cp.key_epoch);
    const next = rows.find((r) => r.epoch === cp.key_epoch + 1);
    const fin = key && key.retired_at !== null ? parseFinalHeads(next?.final_heads).find((h) => h.log === log) : undefined;
    if (fin && cp.tree_size < fin.tree_size && fin.tree_size <= leaves.length)
      finalConsistency = {
        log,
        from: { tree_size: cp.tree_size, root: cp.root },
        to: fin,
        proof: await consistencyProof(leaves.slice(0, fin.tree_size), cp.tree_size, fin.tree_size),
      };
  }
  return {
    log,
    event: { id: row.id, hash: row.hash, leaf_index: index },
    checkpoint: cp,
    proof,
    ...(rows ? { registry_key_history: historyView(rows) } : {}),
    ...(finalConsistency ? { final_consistency: finalConsistency } : {}),
    how_to_verify:
      "RFC 6962 §2.1.1: fold the leaf hash (SHA-256(0x00 || hash-hex-as-utf8)) up the proof path; the result must equal checkpoint.root. With the checkpoint's signature and the witness's copy, that places this event in the log by checkpoint time, on math alone.",
  };
}
