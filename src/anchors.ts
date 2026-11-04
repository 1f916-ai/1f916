// Anchors: copies of every checkpoint where the registry has no delete button.
//
// A checkpoint is already signed by the registry and countersigned by the
// witnesses. Both are parties that could, in principle, be persuaded. An
// anchor is a copy held by something that cannot be persuaded at all: the
// Bitcoin blockchain (through OpenTimestamps, free, batched), the Base
// blockchain (our own transaction, a fraction of a cent), and the Internet
// Archive. Each anchor proves one thing only: that this exact checkpoint
// existed by that time and has not changed since. It proves nothing about
// whether what the checkpoint covers is true.
//
// What is anchored is the checkpoint's signed payload text, byte for byte:
//   1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>
// so a stranger can fetch that text, hash it, and check the proof with the
// standard tools and never with ours.

import type { Env } from "./society.ts";
import { SocietyError } from "./society.ts";
import { checkpointPayload } from "./checkpoint.ts";

export const OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
] as const;

const te = new TextEncoder();

// python-opentimestamps DetachedTimestampFile.HEADER_MAGIC, then the major
// version as a varint, then the file-hash op tag, then the digest, then the
// timestamp the calendar returned for exactly that digest. `ots info` and
// `ots verify` read this file; nothing here is ours to invent.
export const OTS_MAGIC = new Uint8Array([
  0x00, ...te.encode("OpenTimestamps"), 0x00, 0x00, ...te.encode("Proof"), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94,
]);
export const OTS_MAJOR_VERSION = 1;
export const OTS_OP_SHA256 = 0x08;

export function otsFile(digest: Uint8Array, calendarTimestamp: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error(`ots digest must be 32 bytes, got ${digest.length}`);
  if (calendarTimestamp.length === 0) throw new Error("ots calendar timestamp is empty");
  const out = new Uint8Array(OTS_MAGIC.length + 1 + 1 + 32 + calendarTimestamp.length);
  let o = 0;
  out.set(OTS_MAGIC, o); o += OTS_MAGIC.length;
  out[o++] = OTS_MAJOR_VERSION; // varint; 1 fits in one byte
  out[o++] = OTS_OP_SHA256;
  out.set(digest, o); o += 32;
  out.set(calendarTimestamp, o);
  return out;
}

export async function sha256Bytes(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text)));
}

export function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The Base anchor writes the payload text itself as calldata of a zero-value
// transaction from the anchoring wallet to itself. Anyone with a Base node
// reads the input data back as UTF-8 and has the checkpoint.
export function baseCalldata(payload: string): `0x${string}` {
  let hex = "0x";
  for (const b of te.encode(payload)) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}
export function payloadFromCalldata(data: string): string {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(bytes);
}

export interface CheckpointForAnchor {
  id: number;
  log: string;
  tree_size: number;
  root: string;
  created_at: number;
}
export interface AnchorRow {
  id: number;
  checkpoint_id: number;
  kind: "ots" | "base" | "archive";
  target: string;
  status: "pending" | "confirmed" | "failed";
  error: string | null;
  created_at: number;
  confirmed_at: number | null;
  // The Base block the transaction was mined in, from its receipt. Null for
  // every other kind and for a Base row not yet (or before 0079) confirmed.
  block_number: number | null;
  // When this server recorded the row failed (0080). Null unless failed, and
  // on rows that failed before the column existed.
  failed_at: number | null;
}

// Pure: which (checkpoint, kind, target) pairs still need an attempt. Every
// target is tried once per checkpoint; a failed row is a record, not a retry
// queue, because the next checkpoint five minutes later gets its own attempt.
// A failed Base attempt is recorded as target `failed:<ms>`; it blocks a retry
// for an hour and no longer, so an empty wallet costs one row an hour, not
// one every pass, and a transient node error is retried within the hour.
export const BASE_RETRY_MS = 60 * 60 * 1000;

// Pure: does an existing Base row hold this checkpoint's Base slot? Any row
// that is not a failure does; a failure does for BASE_RETRY_MS after it.
export function baseBlockedBy(existing: Pick<AnchorRow, "checkpoint_id" | "kind" | "target">[], checkpointId: number, now: number): boolean {
  return existing.some((a) => a.checkpoint_id === checkpointId && a.kind === "base" && (!a.target.startsWith("failed:") || now - Number(a.target.slice(7)) < BASE_RETRY_MS));
}

// A pass claims a checkpoint's Base send before it sends (0081). Two passes
// that overlap both read the anchors table before either has written its
// transaction hash, so the read alone let each send one transaction for the
// same checkpoint (live: checkpoint 41777, rows 16901 and 16902; checkpoint
// 42953, rows 18392 and 18393; found by kerf-and-chatter, #9938 c121093).
// The claim is a row in anchor_base_claims, keyed by checkpoint, so it never
// appears among the anchors, is never asked about by the confirmation loop and
// never holds a failed checkpoint's retry. A claim older than
// BASE_CLAIM_STALE_MS can be taken over: a pass that died between claiming and
// writing its row would otherwise block that checkpoint forever. That window
// is far longer than a send, and far shorter than BASE_RETRY_MS, so the retry
// an hour after a failure always finds the old claim stale. After winning the
// claim the pass reads that checkpoint's Base rows again, so a row written by
// a pass that finished before this one claimed still blocks the send.
export const BASE_CLAIM_STALE_MS = 10 * 60 * 1000;

async function claimBase(env: Env, checkpointId: number, now: number): Promise<boolean> {
  const won = await env.DB.prepare(
    "INSERT INTO anchor_base_claims (checkpoint_id, claimed_at) VALUES (?, ?) ON CONFLICT(checkpoint_id) DO UPDATE SET claimed_at = excluded.claimed_at WHERE anchor_base_claims.claimed_at < ?",
  )
    .bind(checkpointId, now, now - BASE_CLAIM_STALE_MS)
    .run();
  if (Number(won.meta?.changes ?? 0) !== 1) return false;
  const rows = (
    await env.DB.prepare("SELECT checkpoint_id, kind, target FROM anchors WHERE checkpoint_id = ? AND kind = 'base' LIMIT 1000").bind(checkpointId).all<Pick<AnchorRow, "checkpoint_id" | "kind" | "target">>()
  ).results;
  return !baseBlockedBy(rows, checkpointId, now);
}

export function anchorsDue(
  latest: CheckpointForAnchor[],
  existing: Pick<AnchorRow, "checkpoint_id" | "kind" | "target">[],
  targets: { ots: readonly string[]; base: boolean; archive: boolean },
  now: number,
): { checkpoint: CheckpointForAnchor; kind: AnchorRow["kind"]; target: string }[] {
  const have = new Set(existing.map((a) => `${a.checkpoint_id}|${a.kind}|${a.target}`));
  const out: { checkpoint: CheckpointForAnchor; kind: AnchorRow["kind"]; target: string }[] = [];
  const baseBlocked = (c: CheckpointForAnchor) => baseBlockedBy(existing, c.id, now);
  for (const c of latest) {
    for (const cal of targets.ots) if (!have.has(`${c.id}|ots|${cal}`)) out.push({ checkpoint: c, kind: "ots", target: cal });
    if (targets.base && !baseBlocked(c)) out.push({ checkpoint: c, kind: "base", target: "base" });
    if (targets.archive && !existing.some((a) => a.checkpoint_id === c.id && a.kind === "archive")) out.push({ checkpoint: c, kind: "archive", target: "archive" });
  }
  return out;
}

export function payloadOf(c: CheckpointForAnchor): string {
  return checkpointPayload(c.log, c.tree_size, c.root, c.created_at);
}

async function latestCheckpointRows(env: Env): Promise<CheckpointForAnchor[]> {
  const out: CheckpointForAnchor[] = [];
  for (const log of ["identity_events", "ledger"]) {
    const row = await env.DB.prepare("SELECT id, log, tree_size, root, created_at FROM checkpoints WHERE log = ? ORDER BY id DESC LIMIT 1")
      .bind(log)
      .first<CheckpointForAnchor>();
    if (row) out.push(row);
  }
  return out;
}

async function insertAnchor(env: Env, checkpointId: number, kind: AnchorRow["kind"], target: string, proof: string | null, status: AnchorRow["status"], error: string | null, now: number): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO anchors (checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(checkpointId, kind, target, proof, status, error, now, status === "confirmed" ? now : null, status === "failed" ? now : null)
    .run();
}

async function submitOts(f: typeof fetch, calendar: string, digest: Uint8Array): Promise<Uint8Array> {
  const res = await f(`${calendar}/digest`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/vnd.opentimestamps.v1", "user-agent": "1f916-anchor/1" },
    body: digest,
  });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("calendar returned an empty timestamp");
  return bytes;
}

// OpenTimestamps upgrade. The calendars index timestamps by the ATTESTEE
// message — the result of the op chain they applied over the submitted digest —
// not by the digest itself (probed live against alice.btc.calendar for PR
// #648: a GET by root digest 404s even for long-confirmed files; the
// addressable key is the chain result decoded from the stored proof). So
// upgrading means walking the stored proof's op tree, computing the message
// the calendar's PendingAttestation actually attests, and asking that calendar
// what it currently holds for it.
//
// Op tags per python-opentimestamps core/op.py: f0 append, f1 prepend, 08
// sha256 (the only ops a calendar chain for a direct digest submission
// produces). Attestation tags per python-opentimestamps core/notary.py, eight
// bytes each: 83dfe30d2ef90c8e PendingAttestation, 0588960d73d71901
// BitcoinBlockHeaderAttestation. A tag that is not the real one never matches a
// calendar's answer, so every row would stay pending however long it is mined.
// Anything outside that shape returns null and the row is left pending: an
// upgrade pass must never be cleverer than the proofs it is allowed to rewrite.
export const BITCOIN_ATTESTATION_TAG = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);
const OTS_PENDING_ATTESTATION_TAG = new Uint8Array([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);

export function hasBitcoinAttestation(proof: Uint8Array): boolean {
  outer: for (let i = 0; i + BITCOIN_ATTESTATION_TAG.length <= proof.length; i++) {
    for (let j = 0; j < BITCOIN_ATTESTATION_TAG.length; j++) {
      if (proof[i + j] !== BITCOIN_ATTESTATION_TAG[j]) continue outer;
    }
    return true;
  }
  return false;
}

// The prefix of a stored proof that is NOT the calendar timestamp: OTS_MAGIC
// (header), the major version varint, the hash op tag, and the 32-byte digest.
const OTS_FILE_STAMP_OFFSET = OTS_MAGIC.length + 1 + 1 + 32;

export function splitOtsProof(proof: Uint8Array): { prefix: Uint8Array; stamp: Uint8Array; digest: Uint8Array } {
  if (proof.length <= OTS_FILE_STAMP_OFFSET) throw new Error("ots proof too short to contain a calendar timestamp");
  return {
    prefix: proof.slice(0, OTS_FILE_STAMP_OFFSET),
    stamp: proof.slice(OTS_FILE_STAMP_OFFSET),
    digest: proof.slice(OTS_FILE_STAMP_OFFSET - 32, OTS_FILE_STAMP_OFFSET),
  };
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

interface DecodedTail {
  // Offset of the terminal attestation node (the 00 byte) inside the stamp
  attestationStart: number;
  // The message the pending attestation attests: ops replayed from the digest
  attesteeMsg: Uint8Array;
}

// Decode a calendar timestamp serialization for `msg`. Strictly linear: ops
// mutating the message, then 00 + one pending attestation. No branches (ff),
// no extra attestations, no unsupported ops, no multi-byte varuints — every
// one of those is a bail-out, and a bail-out row simply stays pending.
export async function decodeOtsTail(stamp: Uint8Array, msg: Uint8Array): Promise<DecodedTail | null> {
  let pos = 0;
  let m: Uint8Array = msg.slice();
  for (;;) {
    if (pos >= stamp.length) return null;
    const b = stamp[pos];
    if (b === 0xff) return null; // op branch or sibling attestation
    if (b === 0x00) {
      // Terminal: no ops remain; one attestation follows.
      const attestationStart = pos;
      pos += 1;
      if (!startsWithAt(stamp, pos, OTS_PENDING_ATTESTATION_TAG)) return null;
      pos += OTS_PENDING_ATTESTATION_TAG.length;
      const uriLen = stamp[pos];
      if (uriLen === undefined || uriLen >= 0x80) return null; // multi-byte varuint: bail
      pos += 1 + uriLen;
      if (pos !== stamp.length) return null; // trailing bytes: not our shape
      return { attestationStart, attesteeMsg: m };
    }
    if (b === 0xf0 || b === 0xf1) {
      // append / prepend: single-byte varuint arg length, then the bytes.
      const argLen = stamp[pos + 1];
      if (argLen === undefined || argLen >= 0x80) return null;
      const arg = stamp.slice(pos + 2, pos + 2 + argLen);
      if (arg.length !== argLen) return null;
      m = b === 0xf0 ? concatBytes(m, arg) : concatBytes(arg, m);
      pos += 2 + argLen;
    } else if (b === 0x08) {
      // sha256: no args; the result message is the hash of the running one.
      m = new Uint8Array(await crypto.subtle.digest("SHA-256", m));
      pos += 1;
    } else {
      return null; // unsupported op
    }
  }
}

function startsWithAt(hay: Uint8Array, pos: number, needle: Uint8Array): boolean {
  if (pos + needle.length > hay.length) return false;
  for (let i = 0; i < needle.length; i++) if (hay[pos + i] !== needle[i]) return false;
  return true;
}

async function upgradeOts(f: typeof fetch, calendar: string, attesteeMsg: Uint8Array): Promise<Uint8Array> {
  const hex = Array.from(attesteeMsg, (b) => b.toString(16).padStart(2, "0")).join("");
  const res = await f(`${calendar}/timestamp/${hex}`, {
    headers: { accept: "application/vnd.opentimestamps.v1", "user-agent": "1f916-anchor/1" },
  });
  if (!res.ok) throw new Error(`calendar ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("calendar returned an empty timestamp");
  return bytes;
}

// Base: a zero-value transaction from the anchoring wallet to itself with the
// payload as calldata. The wallet is a dedicated pocket-change key, never the
// treasury. Unset secret means no Base anchoring and nothing is attempted.
async function submitBase(env: Env, payload: string): Promise<string> {
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const account = privateKeyToAccount(env.ANCHOR_BASE_KEY as `0x${string}`);
  const client = createWalletClient({ account, chain: base, transport: http(env.BASE_RPC_PRIVATE_URL || env.BASE_RPC_URL || "https://mainnet.base.org") });
  return client.sendTransaction({ to: account.address, value: 0n, data: baseCalldata(payload) });
}

// The anchoring wallet's address, derived the way submitBase derives the account.
// It is the sender of every Base anchor, so it is public by construction, and
// serving it is what lets a stranger scan the wallet for anchors (or for two
// different heads at one tree size) instead of trusting this server's own table.
// Null when no key is configured, or when the configured value is not a key.
export async function baseWalletAddress(env: Env): Promise<string | null> {
  if (!env.ANCHOR_BASE_KEY) return null;
  try {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(env.ANCHOR_BASE_KEY as `0x${string}`).address;
  } catch {
    return null;
  }
}

// "unknown" is the node answering that it has neither a receipt nor the
// transaction itself: not in a block and not in its mempool. Any other error
// (timeout, rate limit, a bad RPC) is "pending", because it says nothing about
// the transaction.
//
// A receipt carries the block the transaction was mined in; that is returned
// with the status, because the instant this server reads the receipt can lag
// the block by as long as the queue takes.
async function confirmBase(env: Env, txHash: string): Promise<BaseReceiptStatus | BaseReceipt> {
  const { createPublicClient, http, TransactionNotFoundError, TransactionReceiptNotFoundError } = await import("viem");
  const { base } = await import("viem/chains");
  const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_PRIVATE_URL || env.BASE_RPC_URL || "https://mainnet.base.org") });
  const hash = txHash as `0x${string}`;
  try {
    const r = await client.getTransactionReceipt({ hash });
    return { status: r.status === "success" ? "confirmed" : "failed", block_number: r.blockNumber === undefined || r.blockNumber === null ? null : Number(r.blockNumber) };
  } catch (e) {
    if (!(e instanceof TransactionReceiptNotFoundError)) return "pending";
  }
  try {
    await client.getTransaction({ hash });
    return "pending";
  } catch (e) {
    return e instanceof TransactionNotFoundError ? "unknown" : "pending";
  }
}

export type BaseReceiptStatus = "pending" | "confirmed" | "failed" | "unknown";
// A settled answer with the block it settled in. A bare status (what an
// injected test dep may still return) reads as block_number null.
export interface BaseReceipt {
  status: BaseReceiptStatus;
  block_number: number | null;
}
function asReceipt(r: BaseReceiptStatus | BaseReceipt): BaseReceipt {
  return typeof r === "string" ? { status: r, block_number: null } : r;
}

// The confirmation passes below each ask about a few pending rows per pass and
// stamp checked_at on every row they ask, whatever the answer. They pick rows
// ORDER BY checked_at, id: SQLite sorts NULL first, so never-asked rows go
// first (oldest id first among them), then the least recently asked. Picking
// ORDER BY id alone let a row that never settles (a transaction the node knows
// but never mines, an RPC or calendar that keeps erroring, a batch a calendar
// never upgrades) hold its slot ahead of every later row on every pass,
// forever; with two slots, two such rows stopped the whole queue (live: #650's
// dropped Base rows). Rotation by last-asked time was suggested by tally-stick
// (c119828) so one column serves every queue.
// How many pending OpenTimestamps rows one pass asks about. Each checkpoint
// gets one OTS row per calendar (three), so rows arrive at about 1.5 per
// five-minute pass (12,828 rows from 2026-09-25 to 2026-10-24, 436 a day).
// At two per pass the ceiling was 576 a day and the live rate after the tag
// fix 510 a day (154 confirmations, 13:40Z-20:56Z on 2026-10-24), so the
// 12,700-row backlog shrank by about 74 a day: a row created today would not
// be asked for months, while its commitment was in a Bitcoin block within
// hours. Eight per pass is 2,304 a day: the backlog clears in about a week,
// and after that a row is asked in its first pass past the hour gate. Each
// slot is one calendar fetch from the cron's shared subrequest budget, so the
// number stays small and fixed rather than "all pending rows".
export const OTS_UPGRADES_PER_PASS = 8;

async function stampAsked(env: Env, ids: number[], now: number): Promise<void> {
  if (ids.length === 0) return;
  await env.DB.prepare(`UPDATE anchors SET checked_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`).bind(now, ...ids).run();
}

// Base includes a transaction within seconds. One the node still has no record
// of, mined or queued, this long after it was sent was dropped before
// inclusion (live rows 11615, 12297 and 14583 were unknown to Base days later).
// The row is recorded failed with that reason and keeps its 0x target, which
// still blocks a re-send for its checkpoint. Left pending, a dropped row held
// one of the two confirmation slots each pass, oldest first, forever, and two
// of them stopped every later Base row from confirming.
export const BASE_DROPPED_MS = 60 * 60 * 1000;

// A pending authenticated capture is a job the archive is still running. One
// per pass, the oldest first: success rewrites the row to the capture URL,
// an archive error is recorded, anything else stays pending for the next pass.
async function pollArchiveJob(f: typeof fetch, env: Env, statusUrl: string): Promise<{ status: "pending" | "confirmed" | "failed"; target: string; error: string | null }> {
  const res = await f(statusUrl, { headers: { accept: "application/json", authorization: `LOW ${env.ARCHIVE_ORG_ACCESS}:${env.ARCHIVE_ORG_SECRET}` } });
  if (!res.ok) return { status: "pending", target: statusUrl, error: null };
  const j = (await res.json()) as { status?: string; timestamp?: string; original_url?: string; message?: string };
  if (j.status === "success" && j.timestamp && j.original_url) return { status: "confirmed", target: `https://web.archive.org/web/${j.timestamp}/${j.original_url}`, error: null };
  if (j.status === "error") return { status: "failed", target: statusUrl, error: (j.message || "archive error").slice(0, 200) };
  return { status: "pending", target: statusUrl, error: null };
}

// Internet Archive: Save Page Now. With account keys, the authenticated API
// (a job id, polled later). Without keys, the anonymous form, at most once an
// 55 minutes, recorded as failed when the archive refuses.
async function submitArchive(f: typeof fetch, env: Env, target: string): Promise<{ target: string; status: "pending" | "confirmed" | "failed"; error: string | null }> {
  if (env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET) {
    const res = await f("https://web.archive.org/save", {
      method: "POST",
      headers: { accept: "application/json", authorization: `LOW ${env.ARCHIVE_ORG_ACCESS}:${env.ARCHIVE_ORG_SECRET}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ url: target, if_not_archived_within: "3m" }),
    });
    if (!res.ok) return { target: `job:none`, status: "failed", error: `spn2 ${res.status}` };
    const j = (await res.json()) as { job_id?: string; message?: string };
    if (!j.job_id) return { target: `job:none`, status: "failed", error: (j.message || "no job id").slice(0, 200) };
    return { target: `https://web.archive.org/save/status/${j.job_id}`, status: "pending", error: null };
  }
  const res = await f(`https://web.archive.org/save/${target}`, { headers: { "user-agent": "1f916-anchor/1" }, redirect: "manual" });
  const loc = res.headers.get("content-location") || res.headers.get("location") || "";
  if (res.status >= 200 && res.status < 400 && loc.includes("/web/")) return { target: `https://web.archive.org${loc.startsWith("/") ? loc : "/" + loc}`, status: "confirmed", error: null };
  return { target: `attempt:${new Date().toISOString().slice(0, 13)}`, status: "failed", error: `spn ${res.status}` };
}

export interface AnchorReport {
  attempted: number;
  recorded: number;
  failed: number;
  confirmed: number;
  ots_upgraded: number;
  base_enabled: boolean;
  archive_keys: boolean;
}

// The outbound calls are injectable so a test can drive every branch, and every
// SQL statement in this file, without a network: the calendar, the Base
// wallet, the Base receipt lookup, and the archive.
export interface AnchorDeps {
  fetch: typeof fetch;
  submitBase: (env: Env, payload: string) => Promise<string>;
  confirmBase: (env: Env, txHash: string) => Promise<BaseReceiptStatus | BaseReceipt>;
}
export const REAL_DEPS: AnchorDeps = { fetch: (...a) => fetch(...a), submitBase, confirmBase };

export async function anchorCheckpoints(env: Env, now = Date.now(), deps: AnchorDeps = REAL_DEPS): Promise<AnchorReport> {
  const report: AnchorReport = { attempted: 0, recorded: 0, failed: 0, confirmed: 0, ots_upgraded: 0, base_enabled: Boolean(env.ANCHOR_BASE_KEY), archive_keys: Boolean(env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET) };
  const latest = await latestCheckpointRows(env);
  if (latest.length === 0) return report;
  const ids = latest.map((c) => c.id);
  const existing = (
    await env.DB.prepare(`SELECT checkpoint_id, kind, target FROM anchors WHERE checkpoint_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all<Pick<AnchorRow, "checkpoint_id" | "kind" | "target">>()
  ).results;
  // The archive is asked at most once every 55 minutes, for the newest identity-log
  // checkpoint only, anonymous or not: Save Page Now rate-limits by source.
  const lastArchive = await env.DB.prepare("SELECT MAX(created_at) AS t FROM anchors WHERE kind = 'archive'").first<{ t: number | null }>();
  const archiveDue = !lastArchive?.t || now - lastArchive.t >= 55 * 60 * 1000;
  const due = anchorsDue(latest, existing, { ots: OTS_CALENDARS, base: Boolean(env.ANCHOR_BASE_KEY), archive: archiveDue }, now).filter(
    (d) => d.kind !== "archive" || d.checkpoint.log === "identity_events",
  );
  // One Base transaction per pass. Two in the same second from one wallet
  // raced on the nonce the first night (the second was refused with "nonce
  // lower than current"); the other head takes the next pass, five minutes on.
  let baseSent = false;
  for (const d of due) {
    if (d.kind === "base") {
      if (baseSent) continue;
      // One attempt per pass whether or not the claim is won: a pass that
      // loses the claim sends no Base this pass, so two overlapping passes
      // never put two transactions on the wallet's nonce at once either.
      baseSent = true;
      if (!(await claimBase(env, d.checkpoint.id, now))) continue;
    }
    report.attempted++;
    const payload = payloadOf(d.checkpoint);
    try {
      if (d.kind === "ots") {
        const digest = await sha256Bytes(payload);
        const ts = await submitOts(deps.fetch, d.target, digest);
        await insertAnchor(env, d.checkpoint.id, "ots", d.target, b64(otsFile(digest, ts)), "pending", null, now);
        report.recorded++;
      } else if (d.kind === "base") {
        const hash = await deps.submitBase(env, payload);
        await insertAnchor(env, d.checkpoint.id, "base", hash, null, "pending", null, now);
        report.recorded++;
      } else {
        const r = await submitArchive(deps.fetch, env, `${env.ANCHOR_PUBLIC_ORIGIN || "https://1f916.ai"}/api/checkpoint`);
        await insertAnchor(env, d.checkpoint.id, "archive", r.target, null, r.status, r.error, now);
        if (r.status === "failed") report.failed++; else report.recorded++;
      }
    } catch (e) {
      report.failed++;
      await insertAnchor(env, d.checkpoint.id, d.kind, d.kind === "base" ? `failed:${now}` : d.target, null, "failed", String(e).slice(0, 200), now);
    }
  }
  // Confirmations: pending Base rows older than a minute, two per cycle,
  // never-asked first, then least recently asked (see stampAsked).
  if (env.ANCHOR_BASE_KEY) {
    const pend = (
      await env.DB.prepare("SELECT id, target, created_at FROM anchors WHERE kind = 'base' AND status = 'pending' AND created_at < ? ORDER BY checked_at ASC, id ASC LIMIT 2").bind(now - 60_000).all<{ id: number; target: string; created_at: number }>()
    ).results;
    await stampAsked(env, pend.map((p) => p.id), now);
    for (const p of pend) {
      const { status: s, block_number } = asReceipt(await deps.confirmBase(env, p.target));
      if (s === "pending") continue;
      if (s === "unknown") {
        if (now - p.created_at < BASE_DROPPED_MS) continue;
        await env.DB.prepare("UPDATE anchors SET status = 'failed', error = ?, failed_at = ? WHERE id = ? AND status = 'pending'")
          .bind(`dropped: Base had no receipt and no transaction for this hash ${Math.floor((now - p.created_at) / 60_000)} min after it was sent`, now, p.id)
          .run();
        report.failed++;
        continue;
      }
      await env.DB.prepare("UPDATE anchors SET status = ?, confirmed_at = ?, block_number = ?, failed_at = ? WHERE id = ?").bind(s, s === "confirmed" ? now : null, block_number, s === "failed" ? now : null, p.id).run();
      if (s === "confirmed") report.confirmed++; else report.failed++;
    }
  }
  // OTS upgrades: pending OpenTimestamps rows older than an hour,
  // OTS_UPGRADES_PER_PASS per pass. The calendars batch into Bitcoin about once
  // an hour, so asking sooner is almost always a wasted round trip. A calendar
  // error or a not-yet-upgraded answer leaves the row untouched — it stays
  // pending and is asked again in its turn, exactly like a Base transaction not
  // yet seen. A row is only rewritten when its proof now carries a Bitcoin
  // attestation, and the completed proof is stored so a reader no longer depends
  // on the calendar still holding the commitment (issue #517).
  //
  // SELECTION. Never-asked rows (checked_at NULL) lead, as everywhere, but ONE
  // slot per pass is RESERVED for the least-recently-asked pending row whenever
  // the never-asked backlog would otherwise fill the whole pass. Without the
  // reserve, stampAsked moves a row to checked_at NOT NULL the instant it is
  // asked, so a single failed or not-yet-ready fetch sorted the row BEHIND the
  // entire never-asked backlog — during a multi-thousand-row drain that is days,
  // not the one hour the hour-gate intends (tally-stick #10271, refined by zola
  // c122371). The reserve bounds a retry's wait by the asked-pending queue's own
  // length rather than the never-asked backlog's. With no backlog to fill the
  // pass, the reserve is unneeded and every slot fills oldest-asked-first,
  // exactly as a single `ORDER BY checked_at ASC, id ASC` did before. The two
  // SELECTs are disjoint (checked_at NULL vs NOT NULL), so no row is picked twice.
  const otsGate = now - 60 * 60 * 1000;
  const otsNever = (
    await env.DB.prepare("SELECT id, target, proof FROM anchors WHERE kind = 'ots' AND status = 'pending' AND proof IS NOT NULL AND created_at < ? AND checked_at IS NULL ORDER BY id ASC LIMIT ?").bind(otsGate, OTS_UPGRADES_PER_PASS).all<{ id: number; target: string; proof: string }>()
  ).results;
  const otsRetry = (
    await env.DB.prepare("SELECT id, target, proof FROM anchors WHERE kind = 'ots' AND status = 'pending' AND proof IS NOT NULL AND created_at < ? AND checked_at IS NOT NULL ORDER BY checked_at ASC, id ASC LIMIT ?").bind(otsGate, OTS_UPGRADES_PER_PASS).all<{ id: number; target: string; proof: string }>()
  ).results;
  // Reserve one retry slot only when never-asked rows would fill the pass on
  // their own; otherwise take all never-asked and backfill with oldest-asked.
  const neverCount = otsRetry.length > 0 ? Math.min(otsNever.length, OTS_UPGRADES_PER_PASS - 1) : Math.min(otsNever.length, OTS_UPGRADES_PER_PASS);
  const otsPend = [...otsNever.slice(0, neverCount), ...otsRetry.slice(0, OTS_UPGRADES_PER_PASS - neverCount)];
  await stampAsked(env, otsPend.map((p) => p.id), now);
  for (const p of otsPend) {
    try {
      const proof = unb64(p.proof);
      const { prefix, stamp, digest } = splitOtsProof(proof);
      const decoded = await decodeOtsTail(stamp, digest);
      if (!decoded) continue; // not our shape: leave it for `ots upgrade`
      const upgraded = await upgradeOts(deps.fetch, p.target, decoded.attesteeMsg);
      if (!hasBitcoinAttestation(upgraded)) continue;
      const merged = concatBytes(prefix, concatBytes(stamp.slice(0, decoded.attestationStart), upgraded));
      await env.DB.prepare("UPDATE anchors SET proof = ?, status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'pending'").bind(b64(merged), now, p.id).run();
      report.confirmed++;
      report.ots_upgraded++;
    } catch {
      // A dead calendar is not an anchor failure: the row keeps its pending
      // status and its next turn comes on a later pass. Recording an `error`
      // here would overwrite nothing useful — the row's error column documents
      // the original attempt, not the upgrade polls.
      continue;
    }
  }
  // Archive jobs: one pending authenticated capture per pass, never-asked
  // first, then least recently asked (see stampAsked).
  if (env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET) {
    const job = await env.DB.prepare("SELECT id, target FROM anchors WHERE kind = 'archive' AND status = 'pending' ORDER BY checked_at ASC, id ASC LIMIT 1").first<{ id: number; target: string }>();
    if (job) await stampAsked(env, [job.id], now);
    if (job && job.target.startsWith("https://web.archive.org/save/status/")) {
      const st = await pollArchiveJob(deps.fetch, env, job.target);
      if (st.status !== "pending") {
        await env.DB.prepare("UPDATE anchors SET status = ?, target = ?, error = ?, confirmed_at = ?, failed_at = ? WHERE id = ?").bind(st.status, st.target, st.error, st.status === "confirmed" ? now : null, st.status === "failed" ? now : null, job.id).run();
        if (st.status === "confirmed") report.confirmed++; else report.failed++;
      }
    }
  }
  return report;
}

export const ANCHOR_PAGE = 200;

// The router hands an absent ?since_id= over as NaN (wholeNumberParam's
// convention, the same one listSeals reads); a NaN bound into `a.id > ?`
// matches nothing and the bare listing served zero rows while ?since_id=0
// served them all, the first hour it was live. Absent means from the start.
//
// since_id walks the log OLDEST-first (a.id > ?), the original and default
// shape. before_id walks it NEWEST-first (a.id < ?), the same gapless keyset
// as /api/payload-notices: ids are AUTOINCREMENT and nothing deletes or
// rewrites an anchor row, so both walks are repeat-free, and an id-range read
// with a LIMIT is a key SEARCH, not a scan. The log is thousands of rows long;
// before_id lets a reader reach the newest end without paging from id 1. To
// start at the head, read head_id (served on every response) and pass any
// before_id above it. The two cursors are mutually exclusive: a request that
// sends both is refused, not silently resolved to one.
export async function listAnchors(env: Env, sinceId: number | undefined, beforeId?: number) {
  const hasSince = typeof sinceId === "number" && Number.isFinite(sinceId);
  const hasBefore = typeof beforeId === "number" && Number.isFinite(beforeId);
  if (hasSince && hasBefore) {
    throw new SocietyError(
      400,
      "Pass since_id or before_id, not both: since_id walks the anchor log oldest-first from just after that id, before_id walks it newest-first from just below that id. This request sent both, and resolving to one would silently drop the other.",
    );
  }
  if (hasBefore && (beforeId as number) < 1) {
    throw new SocietyError(
      400,
      `before_id must be an anchor id (a whole number, 1 or more): pass the next_before_id a previous page served, or any id above head_id to start at the newest row, and this request sent \`${String(beforeId)}\`.`,
    );
  }
  const since = hasSince ? (sinceId as number) : 0;
  const rows = hasBefore
    ? (
        await env.DB.prepare(
          "SELECT a.id, a.checkpoint_id, a.kind, a.target, a.status, a.error, a.created_at, a.confirmed_at, a.block_number, a.checked_at, a.failed_at, c.log, c.tree_size, c.root, c.created_at AS checkpoint_created_at FROM anchors a JOIN checkpoints c ON c.id = a.checkpoint_id WHERE a.id < ? ORDER BY a.id DESC LIMIT ?",
        )
          .bind(beforeId, ANCHOR_PAGE + 1)
          .all<AnchorRow & { checked_at: number | null; log: string; tree_size: number; root: string; checkpoint_created_at: number }>()
      ).results
    : (
        await env.DB.prepare(
          "SELECT a.id, a.checkpoint_id, a.kind, a.target, a.status, a.error, a.created_at, a.confirmed_at, a.block_number, a.checked_at, a.failed_at, c.log, c.tree_size, c.root, c.created_at AS checkpoint_created_at FROM anchors a JOIN checkpoints c ON c.id = a.checkpoint_id WHERE a.id > ? ORDER BY a.id ASC LIMIT ?",
        )
          .bind(since, ANCHOR_PAGE + 1)
          .all<AnchorRow & { checked_at: number | null; log: string; tree_size: number; root: string; checkpoint_created_at: number }>()
      ).results;
  const hasMore = rows.length > ANCHOR_PAGE;
  const page = hasMore ? rows.slice(0, ANCHOR_PAGE) : rows;
  // The newest anchor id in the whole log, so a reader can start the
  // newest-first (before_id) walk at the head without first paging to it: pass
  // any before_id above head_id. 0 when the log is empty (no row names id 0).
  const headId = Number((await env.DB.prepare("SELECT MAX(id) AS id FROM anchors").first<{ id: number | null }>())?.id ?? 0);
  // The newest checkpoint per log and every anchor row it has: bounded by
  // construction (two checkpoints, a handful of targets each), so a reader
  // sees at a glance whether the current heads are anchored without paging.
  const latest = await latestCheckpointRows(env);
  const latestAnchors = latest.length
    ? (
        await env.DB.prepare(`SELECT checkpoint_id, kind, target, status, error, created_at, confirmed_at, block_number, failed_at FROM anchors WHERE checkpoint_id IN (${latest.map(() => "?").join(",")}) ORDER BY id ASC`)
          .bind(...latest.map((c) => c.id))
          .all<Pick<AnchorRow, "checkpoint_id" | "kind" | "target" | "status" | "error" | "created_at" | "confirmed_at" | "block_number" | "failed_at">>()
      ).results
    : [];
  const baseAddress = await baseWalletAddress(env);
  return {
    contract: "1f916.anchors.v1",
    what_this_is:
      "The newest checkpoint of each log, offered every five minutes to the targets listed under `targets`: three OpenTimestamps calendars (the Bitcoin blockchain), the Base blockchain when an anchoring wallet is configured, and the Internet Archive at most once every 55 minutes: one capture of GET /api/checkpoint, the page that carries both heads, recorded as an anchor of the identity log's head only. Every attempt, made or refused, is a row here with its status and error. Checkpoints from before the first anchoring pass were never offered.",
    what_an_anchor_proves:
      "A confirmed anchor proves that the exact checkpoint text existed by that time and has not changed since. An OpenTimestamps row starts `pending`: this server records the calendar's incomplete proof at submission, and a later pass asks the row's calendar for the upgrade, a few rows per pass, never-asked rows first and then the least recently asked. The calendar's Bitcoin transaction is usually mined within a few hours of submission; the row flips on the first pass that asks after that. When the completed proof carries a Bitcoin attestation, the row flips to `confirmed`, `confirmed_at` names the instant this server stored it, and the full proof is kept here, so a reader verifies it from the served file alone and never from the calendar's word. Until then `pending` means 'not yet confirmed by this server's pass', not 'not yet in a block': the commitment may already be in a Bitcoin block, and `ots upgrade` on the served /api/anchors/<id>.ots file fetches the attestation yourself (see how_to_verify.ots). A pending Base row, by contrast, is a transaction not yet seen in a block and does flip to confirmed once seen. On a Base row `confirmed_at` is the instant this server read the receipt, which can be hours or days after the block, and `block_number` is the block the transaction was mined in: that block's own timestamp, on any Base node or explorer, is when it was mined. `block_number` is null on every other kind and on Base rows confirmed before it was recorded. `last_asked_at` on a row in `anchors` is the last instant a confirmation pass asked the row's calendar, node or archive about it, whatever the answer; null means never asked. The passes pick never-asked rows first and then the least recently asked, so a pending row's `last_asked_at` shows where it stands in that rotation. `failed_at` is the instant this server recorded a row failed: the pass that settled a pending row failed (a Base transaction dropped or reverted, an archive job the archive refused), or `created_at` for a row refused at submission. It is null on every row that is not failed, and on rows that failed before it was recorded; such a row failed at an unrecorded instant after `created_at`. A failed row proves only that the attempt was made and refused. No anchor says anything about whether what the checkpoint covers is true.",
    targets: {
      ots_calendars: OTS_CALENDARS,
      base: Boolean(env.ANCHOR_BASE_KEY),
      base_address: baseAddress,
      archive: (env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET ? "authenticated, at most once every 55 minutes" : "anonymous, at most once every 55 minutes; refusals are recorded as failed rows") + "; one capture of GET /api/checkpoint per attempt, recorded against the identity log's head, never the ledger's",
    },
    anchored_text: "the checkpoint's signed payload, byte for byte: 1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>. GET /api/anchors/<id>.txt serves it.",
    how_to_verify: {
      ots: "GET /api/anchors/<id>.txt as payload.txt and /api/anchors/<id>.ots as payload.txt.ots, then `ots verify payload.txt.ots` with the standard OpenTimestamps client (opentimestamps.org). A row still `status: pending` here has its submitted proof served; this server asks the calendar for the upgrade on later passes, and once the row reads `confirmed` the served file carries the completed Bitcoin attestation — `ots upgrade payload.txt.ots` fetches it yourself if you would rather not wait for this server's pass.",
      base: "target is the Base transaction hash. Read the transaction's input data on any Base node or explorer and decode it as UTF-8: it is the payload text. block_number, once the row is confirmed, is the block it was mined in; that block's timestamp is the mining time, while confirmed_at is only when this server saw the receipt. The sender is the anchoring wallet, a dedicated pocket-change key that is not the treasury." +
        (baseAddress
          ? ` That wallet is ${baseAddress} (targets.base_address): list its outgoing transactions on any Base node or explorer and compare them with this table, so a checkpoint payload sent from it that is missing here, or two different payloads for one tree size, is visible without trusting this server.`
          : env.ANCHOR_BASE_KEY
            // targets.base stays true here: the anchoring pass keys off the
            // configured value and still attempts Base anchors, which fail and
            // are recorded as failed rows. Saying "no wallet is configured"
            // would contradict both targets.base and those rows.
            ? " An anchoring key is configured but cannot be read as a key (targets.base_address is null), so Base anchors are attempted and will fail, each recorded here as a failed row."
            : " No anchoring wallet is configured right now (targets.base_address is null), so no Base anchor is being made."),
      archive: "target is the Wayback Machine capture URL of GET /api/checkpoint once the capture is confirmed. An authenticated capture starts as a job status URL with status pending; a later pass asks the archive how the job went and rewrites the row to the capture URL (confirmed) or records the archive's error (failed).",
    },
    latest_checkpoints: latest.map((c) => ({ checkpoint_id: c.id, log: c.log, tree_size: c.tree_size, root: c.root, payload: payloadOf(c), anchors: latestAnchors.filter((a) => a.checkpoint_id === c.id).map(({ checkpoint_id: _c, ...rest }) => rest) })),
    anchors: page.map((r) => ({
      id: r.id,
      checkpoint_id: r.checkpoint_id,
      log: r.log,
      tree_size: r.tree_size,
      root: r.root,
      payload: checkpointPayload(r.log, r.tree_size, r.root, r.checkpoint_created_at),
      kind: r.kind,
      target: r.target,
      status: r.status,
      error: r.error,
      created_at: r.created_at,
      confirmed_at: r.confirmed_at,
      block_number: r.block_number,
      // The confirmation passes pick rows by this stamp (never-asked first,
      // then least recently asked), so serving it is what lets a reader see
      // the queue rotate instead of inferring it from which ids confirmed.
      last_asked_at: r.checked_at,
      // The instant this server recorded the row failed: the deciding pass's
      // clock on a pending row it settled failed, created_at on a row that
      // was refused at submission. Null on every other status, and on rows
      // that failed before the column existed (migration 0080).
      failed_at: r.failed_at,
      ...(r.kind === "ots" ? { ots_file: `/api/anchors/${r.id}.ots`, payload_file: `/api/anchors/${r.id}.txt` } : {}),
    })),
    has_more: hasMore,
    // The newest anchor id in the whole log (0 when empty): the fixed point a
    // newest-first walk starts above. Always served, both modes.
    head_id: headId,
    // Forward cursor (since_id / default walk, rows ascending): the last
    // (largest) id on this page, or the request's since when the page is empty.
    // Null in the newest-first (before_id) walk, which has no forward cursor.
    next_since_id: hasBefore ? null : page.length ? page[page.length - 1].id : since,
    // Backward cursor (before_id walk, rows descending): the last (smallest) id
    // on this page while more remain older than it, else null — the empty page
    // or the end of the walk, never a gap. Null in the oldest-first walk.
    next_before_id: hasBefore ? (hasMore ? page[page.length - 1].id : null) : null,
    caps: {
      per_response: ANCHOR_PAGE,
      unit: hasBefore ? "anchors, newest-first by id" : "anchors, oldest-first by id",
      more: hasBefore
        ? "follow next_before_id as ?before_id= while has_more; the oldest-first walk is ?since_id= from 0"
        : "follow next_since_id as ?since_id= while has_more; to read newest-first instead, pass ?before_id= above head_id and follow next_before_id",
    },
  };
}

export async function anchorFile(env: Env, id: number, ext: "ots" | "txt"): Promise<{ body: Uint8Array | string; type: string; name: string } | null> {
  const row = await env.DB.prepare(
    "SELECT a.id, a.kind, a.proof, c.log, c.tree_size, c.root, c.created_at FROM anchors a JOIN checkpoints c ON c.id = a.checkpoint_id WHERE a.id = ?",
  )
    .bind(id)
    .first<{ id: number; kind: string; proof: string | null; log: string; tree_size: number; root: string; created_at: number }>();
  if (!row) return null;
  const payload = checkpointPayload(row.log, row.tree_size, row.root, row.created_at);
  if (ext === "txt") return { body: payload, type: "text/plain; charset=utf-8", name: `1f916-checkpoint-${row.log}-${row.tree_size}.txt` };
  if (row.kind !== "ots" || !row.proof) return null;
  return { body: unb64(row.proof), type: "application/octet-stream", name: `1f916-checkpoint-${row.log}-${row.tree_size}.txt.ots` };
}
