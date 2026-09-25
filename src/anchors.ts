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
}

// Pure: which (checkpoint, kind, target) pairs still need an attempt. Every
// target is tried once per checkpoint; a failed row is a record, not a retry
// queue, because the next checkpoint five minutes later gets its own attempt.
// A failed Base attempt is recorded as target `failed:<ms>`; it blocks a retry
// for an hour and no longer, so an empty wallet costs one row an hour, not
// one every pass, and a transient node error is retried within the hour.
export const BASE_RETRY_MS = 60 * 60 * 1000;

export function anchorsDue(
  latest: CheckpointForAnchor[],
  existing: Pick<AnchorRow, "checkpoint_id" | "kind" | "target">[],
  targets: { ots: readonly string[]; base: boolean; archive: boolean },
  now: number,
): { checkpoint: CheckpointForAnchor; kind: AnchorRow["kind"]; target: string }[] {
  const have = new Set(existing.map((a) => `${a.checkpoint_id}|${a.kind}|${a.target}`));
  const out: { checkpoint: CheckpointForAnchor; kind: AnchorRow["kind"]; target: string }[] = [];
  const baseBlocked = (c: CheckpointForAnchor) =>
    existing.some((a) => a.checkpoint_id === c.id && a.kind === "base" && (!a.target.startsWith("failed:") || now - Number(a.target.slice(7)) < BASE_RETRY_MS));
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
    "INSERT OR IGNORE INTO anchors (checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(checkpointId, kind, target, proof, status, error, now, status === "confirmed" ? now : null)
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

async function confirmBase(env: Env, txHash: string): Promise<"pending" | "confirmed" | "failed"> {
  const { createPublicClient, http } = await import("viem");
  const { base } = await import("viem/chains");
  const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_PRIVATE_URL || env.BASE_RPC_URL || "https://mainnet.base.org") });
  try {
    const r = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    return r.status === "success" ? "confirmed" : "failed";
  } catch {
    return "pending";
  }
}

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
  base_enabled: boolean;
  archive_keys: boolean;
}

// The outbound calls are injectable so a test can drive every branch, and every
// SQL statement in this file, without a network: the calendar, the Base
// wallet, the Base receipt lookup, and the archive.
export interface AnchorDeps {
  fetch: typeof fetch;
  submitBase: (env: Env, payload: string) => Promise<string>;
  confirmBase: (env: Env, txHash: string) => Promise<"pending" | "confirmed" | "failed">;
}
export const REAL_DEPS: AnchorDeps = { fetch: (...a) => fetch(...a), submitBase, confirmBase };

export async function anchorCheckpoints(env: Env, now = Date.now(), deps: AnchorDeps = REAL_DEPS): Promise<AnchorReport> {
  const report: AnchorReport = { attempted: 0, recorded: 0, failed: 0, confirmed: 0, base_enabled: Boolean(env.ANCHOR_BASE_KEY), archive_keys: Boolean(env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET) };
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
      baseSent = true;
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
  // Confirmations: pending Base rows older than a minute, two per cycle.
  if (env.ANCHOR_BASE_KEY) {
    const pend = (
      await env.DB.prepare("SELECT id, target FROM anchors WHERE kind = 'base' AND status = 'pending' AND created_at < ? ORDER BY id ASC LIMIT 2").bind(now - 60_000).all<{ id: number; target: string }>()
    ).results;
    for (const p of pend) {
      const s = await deps.confirmBase(env, p.target);
      if (s === "pending") continue;
      await env.DB.prepare("UPDATE anchors SET status = ?, confirmed_at = ? WHERE id = ?").bind(s, s === "confirmed" ? now : null, p.id).run();
      if (s === "confirmed") report.confirmed++; else report.failed++;
    }
  }
  // Archive jobs: one pending authenticated capture per pass, oldest first.
  if (env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET) {
    const job = await env.DB.prepare("SELECT id, target FROM anchors WHERE kind = 'archive' AND status = 'pending' ORDER BY id ASC LIMIT 1").first<{ id: number; target: string }>();
    if (job && job.target.startsWith("https://web.archive.org/save/status/")) {
      const st = await pollArchiveJob(deps.fetch, env, job.target);
      if (st.status !== "pending") {
        await env.DB.prepare("UPDATE anchors SET status = ?, target = ?, error = ?, confirmed_at = ? WHERE id = ?").bind(st.status, st.target, st.error, st.status === "confirmed" ? now : null, job.id).run();
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
export async function listAnchors(env: Env, sinceId: number | undefined) {
  const since = typeof sinceId === "number" && Number.isFinite(sinceId) ? sinceId : 0;
  const rows = (
    await env.DB.prepare(
      "SELECT a.id, a.checkpoint_id, a.kind, a.target, a.status, a.error, a.created_at, a.confirmed_at, c.log, c.tree_size, c.root, c.created_at AS checkpoint_created_at FROM anchors a JOIN checkpoints c ON c.id = a.checkpoint_id WHERE a.id > ? ORDER BY a.id ASC LIMIT ?",
    )
      .bind(since, ANCHOR_PAGE + 1)
      .all<AnchorRow & { log: string; tree_size: number; root: string; checkpoint_created_at: number }>()
  ).results;
  const hasMore = rows.length > ANCHOR_PAGE;
  const page = hasMore ? rows.slice(0, ANCHOR_PAGE) : rows;
  // The newest checkpoint per log and every anchor row it has: bounded by
  // construction (two checkpoints, a handful of targets each), so a reader
  // sees at a glance whether the current heads are anchored without paging.
  const latest = await latestCheckpointRows(env);
  const latestAnchors = latest.length
    ? (
        await env.DB.prepare(`SELECT checkpoint_id, kind, target, status, error, created_at, confirmed_at FROM anchors WHERE checkpoint_id IN (${latest.map(() => "?").join(",")}) ORDER BY id ASC`)
          .bind(...latest.map((c) => c.id))
          .all<Pick<AnchorRow, "checkpoint_id" | "kind" | "target" | "status" | "error" | "created_at" | "confirmed_at">>()
      ).results
    : [];
  return {
    contract: "1f916.anchors.v1",
    what_this_is:
      "The newest checkpoint of each log, offered every five minutes to the targets listed under `targets`: three OpenTimestamps calendars (the Bitcoin blockchain), the Base blockchain when an anchoring wallet is configured, and the Internet Archive at most once every 55 minutes: one capture of GET /api/checkpoint, the page that carries both heads, recorded as an anchor of the identity log's head only. Every attempt, made or refused, is a row here with its status and error. Checkpoints from before the first anchoring pass were never offered.",
    what_an_anchor_proves:
      "A confirmed anchor proves that the exact checkpoint text existed by that time and has not changed since. A pending OpenTimestamps row is the calendar's promise until its Bitcoin transaction confirms; a pending Base row is a transaction not yet seen in a block; a failed row proves only that the attempt was made and refused. No anchor says anything about whether what the checkpoint covers is true.",
    targets: {
      ots_calendars: OTS_CALENDARS,
      base: Boolean(env.ANCHOR_BASE_KEY),
      archive: (env.ARCHIVE_ORG_ACCESS && env.ARCHIVE_ORG_SECRET ? "authenticated, at most once every 55 minutes" : "anonymous, at most once every 55 minutes; refusals are recorded as failed rows") + "; one capture of GET /api/checkpoint per attempt, recorded against the identity log's head, never the ledger's",
    },
    anchored_text: "the checkpoint's signed payload, byte for byte: 1f916.checkpoint.v1:<log>:<tree_size>:<root>:<created_at>. GET /api/anchors/<id>.txt serves it.",
    how_to_verify: {
      ots: "GET /api/anchors/<id>.txt as payload.txt and /api/anchors/<id>.ots as payload.txt.ots, then `ots verify payload.txt.ots` with the standard OpenTimestamps client (opentimestamps.org). A fresh proof is pending until the calendar's Bitcoin transaction confirms; `ots upgrade payload.txt.ots` fetches the completed proof from the calendar. The registry serves the pending file it received and never edits it.",
      base: "target is the Base transaction hash. Read the transaction's input data on any Base node or explorer and decode it as UTF-8: it is the payload text. The sender is the anchoring wallet, a dedicated pocket-change key that is not the treasury.",
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
      ...(r.kind === "ots" ? { ots_file: `/api/anchors/${r.id}.ots`, payload_file: `/api/anchors/${r.id}.txt` } : {}),
    })),
    has_more: hasMore,
    next_since_id: page.length ? page[page.length - 1].id : since,
    caps: { per_response: ANCHOR_PAGE, unit: "anchors, oldest-first by id" },
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
