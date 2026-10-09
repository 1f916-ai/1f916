// The stamping job's half of the public witness protocol: it hands each new
// signed note (src/checkpoint.ts, signNoteFor) to the independent witnesses
// named in TLOG_WITNESSES, keeps the cosignatures that verify, and serves them
// beside the stamp. The protocol itself, and the check of what a witness sends
// back, are src/tlog-witness.ts, called here and not changed.
//
// Why: the one outside check on the registry's heads is its own GitHub job,
// which wrote no line from 2026-09-28T16:26Z to 2026-10-08T19:52Z. A cosignature
// from someone else's machine, served with the note, lets any reader see that a third
// party saw this head and never saw the log go backwards or fork; and the
// state served beside it (when each witness last signed, and what went wrong
// since) makes a silent witness visible in the response itself.
//
// INERT BY DEFAULT. With TLOG_WITNESSES unset or blank nothing here runs: no
// request leaves, no row is read or written, and the served checkpoint and
// note are what they were before this file existed.
//
// TLOG_WITNESSES: one witness per line (or separated by ';'), each
//   <submission prefix URL> <verifier key>
// where the verifier key is the witness operator's published
// <name>+<key id>+<base64(0x04 || Ed25519 key)>, and the URL is the prefix
// that /add-checkpoint is appended to. Lines starting with '#' are skipped.
// An entry that does not parse is logged and skipped, never thrown; so is an
// ML-DSA-44 (0x06) key, whose cosignatures this runtime cannot verify.
//
// What one tick costs at most: per witness and per log, two requests (the
// module never loops), each with its own timeout and a bounded read. A failed
// witness is asked again no sooner than RETRY_AFTER_FAILURE_MS later, so a log
// a witness does not list costs it two requests per log per half hour, not
// two on every tick. A witness that has signed the newest stamp is not asked
// again until there is a newer one.

import { consistencyProof } from "./merkle.ts";
import { checkpointBody, noteFromField, originOf, NOTE_KEY_NAME } from "./note.ts";
import { COSIGNATURE_V1_TYPE, MAX_ANSWER_CHARS, parseWitnessVkey, submitCheckpoint, type SubmitArgs, type SubmitResult, type WitnessKey } from "./tlog-witness.ts";
import type { Env } from "./society.ts";

export const WITNESS_LOGS = ["identity_events", "ledger"] as const;
// More entries than this are ignored (and said so in the log): each witness
// costs subrequests on the one cron tick that also stamps and anchors.
export const MAX_WITNESSES = 5;
// Each request's own deadline. A witness that has not answered by then is a
// network-error row, and the tick goes on.
export const WITNESS_TIMEOUT_MS = 10_000;
// After a refusal or an outage, wait this long before asking that witness about
// that log again.
export const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
// Cosignature lines kept per witness key per log, newest stamps first.
export const COSIGNATURES_KEPT = 16;

export interface WitnessConfig {
  url: string;
  key: WitnessKey;
  vkey: string;
}

// True when anything is configured at all. Cheap and synchronous, so the
// served routes can stay byte-identical when nothing is.
export function witnessesConfigured(env: Env): boolean {
  return typeof env.TLOG_WITNESSES === "string" && env.TLOG_WITNESSES.trim() !== "";
}

export async function readWitnessConfig(env: Env): Promise<{ witnesses: WitnessConfig[]; errors: string[] }> {
  const witnesses: WitnessConfig[] = [];
  const errors: string[] = [];
  if (!witnessesConfigured(env)) return { witnesses, errors };
  const entries = (env.TLOG_WITNESSES as string)
    .split(/[\n;]+/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  for (const entry of entries) {
    const parts = entry.split(/\s+/);
    if (parts.length !== 2) {
      errors.push(`an entry is '<url> <verifier key>': ${entry.slice(0, 80)}`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(parts[0]);
    } catch {
      errors.push(`not a URL: ${parts[0].slice(0, 80)}`);
      continue;
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      errors.push(`a witness is reached over https, with no credentials, query or fragment: ${url.protocol}//${url.host}`);
      continue;
    }
    let key: WitnessKey;
    try {
      key = await parseWitnessVkey(parts[1]);
    } catch (e) {
      errors.push(String((e as Error).message ?? e).slice(0, 160));
      continue;
    }
    // parseWitnessVkey reads an ML-DSA-44 (0x06) key, but verifyCosignatureV1
    // checks only Ed25519 (0x04): such a witness could never cosign here and
    // would be asked again every RETRY_AFTER_FAILURE_MS forever.
    if (key.type !== COSIGNATURE_V1_TYPE) {
      errors.push(`the key ${key.name}+${key.keyId} is type 0x${key.type.toString(16).padStart(2, "0")}; this log verifies only 0x04 Ed25519 cosignatures, so ${key.name} is not asked`);
      continue;
    }
    if (witnesses.some((w) => w.key.name === key.name && w.key.keyId === key.keyId)) {
      errors.push(`the key ${key.name}+${key.keyId} is listed twice`);
      continue;
    }
    if (witnesses.length >= MAX_WITNESSES) {
      errors.push(`more than ${MAX_WITNESSES} witnesses; ${key.name} and any after it are not asked`);
      break;
    }
    witnesses.push({ url: url.href.replace(/\/+$/, ""), key, vkey: parts[1] });
  }
  return { witnesses, errors };
}

// The real network, with a deadline and a bounded read. The module bounds what
// it parses; capping what is read off the wire is this side's job.
export const boundedFetch: SubmitArgs["fetchImpl"] = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(WITNESS_TIMEOUT_MS), redirect: "manual" });
  const limit = MAX_ANSWER_CHARS * 4 + 1;
  let body = "";
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    if (total >= limit) await reader.cancel().catch(() => {});
    const all = new Uint8Array(Math.min(total, limit));
    let o = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, all.length - o);
      all.set(c.subarray(0, take), o);
      o += take;
      if (o >= all.length) break;
    }
    body = new TextDecoder().decode(all);
  }
  return { status: res.status, text: async () => body };
};

interface StateRow {
  last_signed_size: number;
  last_cosigned_checkpoint_id: number | null;
  last_attempt_at: number | null;
  last_result: string | null;
  last_ok_at: number | null;
}
interface StampRow {
  id: number;
  tree_size: number;
  root: string;
  signature: string;
}

function resultLabel(r: SubmitResult): { result: string; detail: string | null } {
  switch (r.kind) {
    case "cosigned":
      return { result: "cosigned", detail: r.unverified.length ? `${r.unverified.length} line(s) did not verify and were not kept` : null };
    case "witness-ahead":
      return { result: "witness-ahead", detail: `the witness says it has signed size ${r.witnessSize}, past this stamp's ${r.size}; asked again after the wait` };
    case "refused":
      return {
        result: `refused:${r.answer.kind}`,
        detail:
          r.answer.kind === "conflict"
            ? `the witness says it last signed size ${r.answer.size}`
            : r.answer.kind === "malformed"
              ? `HTTP ${r.answer.status}: ${r.answer.reason}`
              : r.answer.kind === "other"
                ? `HTTP ${r.answer.status}`
                : null,
      };
    case "no-valid-cosignature":
      return { result: "no-valid-cosignature", detail: `${r.unverified.length} line(s), none a valid cosignature of this stamp by this key` };
    case "network-error":
      return { result: "network-error", detail: r.message.slice(0, 200) };
  }
}

export interface CosignSummary {
  witnesses: number;
  attempted: number;
  cosigned: number;
  failed: number;
  config_errors: string[];
}

// Cron entry, run after the stamps are written. Never throws for a witness's
// sake: every outcome is a row, and the tick goes on.
export async function cosignCheckpoints(env: Env, opts: { fetchImpl?: SubmitArgs["fetchImpl"]; nowMs?: number } = {}): Promise<CosignSummary> {
  const summary: CosignSummary = { witnesses: 0, attempted: 0, cosigned: 0, failed: 0, config_errors: [] };
  if (!witnessesConfigured(env)) return summary;
  const { witnesses, errors } = await readWitnessConfig(env);
  summary.witnesses = witnesses.length;
  summary.config_errors = errors;
  if (witnesses.length === 0) return summary;
  const fetchImpl = opts.fetchImpl ?? boundedFetch;
  const now = opts.nowMs ?? Date.now();

  for (const log of WITNESS_LOGS) {
    // The newest stamp that has a note. A stamp without one cannot be sent.
    const stamp = await env.DB.prepare(
      "SELECT c.id, c.tree_size, c.root, n.signature FROM checkpoints c JOIN checkpoint_notes n ON n.checkpoint_id = c.id WHERE c.log = ? ORDER BY c.id DESC LIMIT 1",
    )
      .bind(log)
      .first<StampRow>();
    if (!stamp) continue;
    // The note exactly as the log signed it, with no other witness's line: a
    // witness reads the log's signature and ignores the rest, but there is no
    // reason to make it.
    const note = noteFromField(checkpointBody(originOf(log), stamp.tree_size, stamp.root), NOTE_KEY_NAME, stamp.signature);
    // Read once per log per tick, and only if some witness needs a proof.
    let leavesRead: Promise<string[]> | null = null;
    const proofFor = async (from: number, to: number) => {
      leavesRead ??= env.DB.prepare(`SELECT hash FROM ${log} WHERE hash IS NOT NULL ORDER BY id ASC`)
        .all<{ hash: string }>()
        .then(({ results }) => results.map((r) => r.hash));
      const leaves = await leavesRead;
      if (leaves.length < to) throw new Error(`the log holds ${leaves.length} sealed rows, fewer than the stamp's ${to}`);
      return consistencyProof(leaves.slice(0, to), from, to);
    };

    await Promise.all(
      witnesses.map(async (w) => {
        const state = await env.DB.prepare(
          "SELECT last_signed_size, last_cosigned_checkpoint_id, last_attempt_at, last_result, last_ok_at FROM tlog_witness_state WHERE witness = ? AND key_id = ? AND log = ?",
        )
          .bind(w.key.name, w.key.keyId, log)
          .first<StateRow>();
        if (state) {
          if (state.last_cosigned_checkpoint_id !== null && state.last_cosigned_checkpoint_id >= stamp.id) return;
          const failed = state.last_result !== null && state.last_result !== "cosigned";
          if (failed && state.last_attempt_at !== null && now - state.last_attempt_at < RETRY_AFTER_FAILURE_MS) return;
        }
        summary.attempted++;
        let result: SubmitResult;
        try {
          result = await submitCheckpoint({ url: w.url, key: w.key, note, lastCosignedSize: state?.last_signed_size ?? 0, proofFor, fetchImpl, nowMs: now });
        } catch (e) {
          // submitCheckpoint catches the network; this is anything else.
          result = { kind: "network-error", message: String(e).slice(0, 200), attempts: 0 };
        }
        const { result: label, detail } = resultLabel(result);
        // Only a size the witness cosigned and this side verified is stored as
        // signed. A size it merely names (a 409, a claim past this log) is its
        // word: it goes in last_detail, and the next attempt's 409 names it again.
        const signedSize = result.kind === "cosigned" ? result.size : (state?.last_signed_size ?? 0);
        const ok = result.kind === "cosigned";
        if (result.kind === "cosigned") {
          summary.cosigned++;
          for (const v of result.verified) {
            await env.DB.prepare(
              "INSERT OR IGNORE INTO checkpoint_cosignatures (checkpoint_id, log, tree_size, root, witness, key_id, timestamp, line, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
              .bind(stamp.id, log, stamp.tree_size, stamp.root, w.key.name, w.key.keyId, v.timestamp, v.line, now)
              .run();
          }
          await env.DB.prepare(
            "DELETE FROM checkpoint_cosignatures WHERE log = ? AND witness = ? AND key_id = ? AND checkpoint_id NOT IN (SELECT checkpoint_id FROM checkpoint_cosignatures WHERE log = ? AND witness = ? AND key_id = ? ORDER BY checkpoint_id DESC LIMIT ?)",
          )
            .bind(log, w.key.name, w.key.keyId, log, w.key.name, w.key.keyId, COSIGNATURES_KEPT)
            .run();
        } else {
          summary.failed++;
        }
        await env.DB.prepare(
          "INSERT INTO tlog_witness_state (witness, key_id, log, last_signed_size, last_cosigned_checkpoint_id, last_attempt_at, last_result, last_detail, last_ok_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT (witness, key_id, log) DO UPDATE SET last_signed_size = excluded.last_signed_size, " +
            "last_cosigned_checkpoint_id = COALESCE(excluded.last_cosigned_checkpoint_id, last_cosigned_checkpoint_id), " +
            "last_attempt_at = excluded.last_attempt_at, last_result = excluded.last_result, last_detail = excluded.last_detail, " +
            "last_ok_at = COALESCE(excluded.last_ok_at, last_ok_at)",
        )
          .bind(w.key.name, w.key.keyId, log, signedSize, ok ? stamp.id : null, now, label, detail, ok ? now : null)
          .run();
      }),
    );
  }
  return summary;
}

export interface ServedCosignature {
  witness: string;
  key_id: string;
  timestamp: number;
  line: string;
}

// The verified lines kept for one stamp that are still SERVED: only those of a
// witness in the current configuration, matched by name and key id. A witness
// is usually removed because something went wrong with it (a leaked key, an
// operator misbehaving), so its lines stop being presented the moment it leaves
// TLOG_WITNESSES; the rows stay, as the history of what was verified when, and
// are pruned by the same bound. Nothing configured serves nothing and reads
// nothing. A deploy can serve this code before the migration has run; a
// missing table reads as none.
export async function cosignaturesFor(env: Env, checkpointId: number, witnesses?: WitnessConfig[]): Promise<ServedCosignature[]> {
  if (!witnessesConfigured(env)) return [];
  const current = witnesses ?? (await readWitnessConfig(env)).witnesses;
  if (current.length === 0) return [];
  const allowed = new Set(current.map((w) => `${w.key.name}+${w.key.keyId}`));
  try {
    const { results } = await env.DB.prepare("SELECT witness, key_id, timestamp, line FROM checkpoint_cosignatures WHERE checkpoint_id = ? ORDER BY witness, key_id")
      .bind(checkpointId)
      .all<ServedCosignature>();
    return results.filter((c) => allowed.has(`${c.witness}+${c.key_id}`));
  } catch {
    return [];
  }
}

// What GET /api/checkpoint adds, and only when a witness is configured.
// Otherwise null, and the response is what it was before witnesses were wired.
export async function witnessView(env: Env, rows: { id: number; log: string; tree_size: number }[]) {
  if (!witnessesConfigured(env)) return null;
  const { witnesses } = await readWitnessConfig(env);
  if (witnesses.length === 0) return null;
  const cosignatures: (ServedCosignature & { log: string; tree_size: number })[] = [];
  for (const r of rows) for (const c of await cosignaturesFor(env, r.id, witnesses)) cosignatures.push({ log: r.log, tree_size: r.tree_size, ...c });
  const cosigning_witnesses = [];
  for (const w of witnesses) {
    const logs: Record<string, unknown> = {};
    for (const log of WITNESS_LOGS) {
      let s: (StateRow & { last_detail: string | null }) | null = null;
      try {
        s = await env.DB.prepare(
          "SELECT last_signed_size, last_cosigned_checkpoint_id, last_attempt_at, last_result, last_detail, last_ok_at FROM tlog_witness_state WHERE witness = ? AND key_id = ? AND log = ?",
        )
          .bind(w.key.name, w.key.keyId, log)
          .first();
      } catch {
        s = null;
      }
      logs[log] = s
        ? { last_signed_size: s.last_signed_size, last_attempt_at: s.last_attempt_at, last_result: s.last_result, last_detail: s.last_detail, last_ok_at: s.last_ok_at }
        : { last_signed_size: 0, last_attempt_at: null, last_result: null, last_detail: null, last_ok_at: null };
    }
    cosigning_witnesses.push({ name: w.key.name, key_id: w.key.keyId, verifier_key: w.vkey, url: w.url, logs });
  }
  return {
    cosignatures,
    cosigning_witnesses,
    cosignature_format:
      "C2SP tlog-cosignature (cosignature/v1): each line is '— <witness name> <base64(key id (4) || time, u64 big-endian (8) || Ed25519 signature (64))>', the signature over 'cosignature/v1\\ntime <time>\\n' followed by the checkpoint text. The same lines follow the registry's own on GET /api/checkpoint/note/<log>, so a verifier pinning a witness's key checks the note as it would any other. Lines are kept only after they verify against the witness's configured key, and served only while that witness (name and key id) is still configured; the newest " +
      COSIGNATURES_KEPT +
      " per witness per log are kept.",
  };
}
