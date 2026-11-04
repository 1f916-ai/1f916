// A witness POSTs the countersignature row it already published; the registry
// verifies it, keeps the newest per witness per log, and signs a receipt
// (#8308; c100814, c101269, c101686).
//
// Why the direction is reversed: the society's own witness runs on GitHub's
// scheduler, which skipped most of its slots (9 starts in about 58 scheduled
// slots after a second cron minute was added), and the Worker deliberately never calls
// GitHub (src/witness-cadence.ts), so the registry cannot fetch a witness file
// to see who is behind. A witness that pushes what it published lets the
// directory serve how far each one has got, from the registry's own records.
//
// What a reader can recompute: witness_sig verifies under the witness's public
// key over the witness.v1 preimage (WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT in
// src/chain.ts), and (log, tree_size, root) is a checkpoint on GET
// /api/checkpoint. The one thing a reader cannot recompute is received_at, when
// this registry accepted the row, so the receipt signs it.
//
// received_at is milliseconds since the Unix epoch, an INTEGER from Date.now():
// the representation checkpoints.created_at uses (makeCheckpoints in
// src/checkpoint.ts) and every *_at field this registry serves, so lag against
// a checkpoint is a subtraction.
//
// Cost: the door is unauthenticated (a countersignature is checked against a
// public key, not a bearer secret), so the bound is the edge's 60 requests a
// minute per IP and the fact that only a row with a LARGER tree_size than the
// stored one writes. The stored set is at most two rows per witness.

import { registrySigner } from "./checkpoint.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import type { Env } from "./society.ts";

export const WITNESS_RECEIPT_PAYLOAD_PREFIX = "1f916.witness-receipt.v1";

// The preimage witness/bin/witness.mjs signs (counterPayload): it names the
// registry origin and omits created_at on purpose, since the witness attests
// the head it verified, not the registry's clock.
const WITNESS_COUNTERSIGNATURE_PREFIX = "1f916.witness.v1";

type PushLog = "identity_events" | "ledger";

export type CountersignedRow = {
  tree_size: number;
  root: string;
  witness_sig: string;
  witness_epoch: number;
  checkpoint_id: number;
  received_at: number;
  receipt: { payload: string; sig: string };
};

interface StoredRow {
  witness_id: number;
  log: PushLog;
  tree_size: number;
  root: string;
  witness_sig: string;
  witness_epoch: number;
  checkpoint_id: number;
  received_at: number;
  receipt_payload: string;
  receipt_sig: string;
}

const STORED_COLUMNS = "witness_id, log, tree_size, root, witness_sig, witness_epoch, checkpoint_id, received_at, receipt_payload, receipt_sig";

type Answer = { status: number; body: Record<string, unknown> };

const refuse = (status: number, error: string, note: string): Answer => ({ status, body: { error, note } });

// The answer when a stored row for (witness, log) is at least as large as the
// one offered, or null when the offered row is larger and should be written.
// Used on the first read and again after a conditional write that changed
// nothing because a concurrent request stored a larger row first.
function answerForStored(stored: StoredRow, treeSize: number, root: string): Answer | null {
  if (stored.tree_size === treeSize && stored.root === root)
    return { status: 200, body: { accepted: true, deduplicated: true, receipt: { payload: stored.receipt_payload, sig: stored.receipt_sig } } };
  if (stored.tree_size >= treeSize)
    return {
      status: 200,
      body: {
        accepted: false,
        reason: `this registry already holds a countersignature from this witness for ${stored.log} at tree_size ${stored.tree_size}, which is not smaller than ${treeSize}. An older row cannot improve or rewind what the directory shows, so nothing was stored.`,
      },
    };
  return null;
}

export async function acceptCountersignature(env: Env, witnessId: number, body: unknown, origin: string): Promise<Answer> {
  // 1. The body: exactly four fields, each the shape a witness file row has.
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return refuse(400, "the body must be a JSON object with log, tree_size, root and witness_sig", "Send the four fields of a countersigned row from your witness file.");
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b).sort();
  if (keys.join(",") !== "log,root,tree_size,witness_sig")
    return refuse(400, `the body must have exactly log, tree_size, root and witness_sig; got ${keys.length ? keys.join(", ") : "no fields"}`, "Extra and missing fields are both refused, so a field this door does not read never looks as though it was.");
  const { log, tree_size: treeSize, root, witness_sig: witnessSig } = b;
  if (log !== "identity_events" && log !== "ledger") return refuse(400, "log must be identity_events or ledger", "These are the two logs GET /api/checkpoint stamps.");
  if (typeof treeSize !== "number" || !Number.isSafeInteger(treeSize) || treeSize <= 0)
    return refuse(400, "tree_size must be a positive integer", "It is the tree_size of the checkpoint you countersigned, as a JSON number.");
  if (typeof root !== "string" || !/^[0-9a-f]{64}$/.test(root))
    return refuse(400, "root must be 64 lowercase hex characters", "It is the checkpoint's root exactly as GET /api/checkpoint serves it.");
  if (typeof witnessSig !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(witnessSig))
    return refuse(400, "witness_sig must be base64url, unpadded, 86 characters (the 64 raw signature bytes)", "It is the witness_sig field of your witness file's countersigned row.");

  // 2. Which witness: a directory row with a key to check against.
  const witness = await env.DB.prepare("SELECT id, public_key, epoch FROM witnesses WHERE id = ?")
    .bind(witnessId)
    .first<{ id: number; public_key: string | null; epoch: number }>();
  if (!witness) return refuse(404, `no witness ${witnessId}`, "GET /api/witnesses lists the registered witnesses and their ids.");
  if (witness.public_key === null)
    return refuse(409, "a witness with no key cannot be checked; register a key", "A countersignature is accepted only when it verifies under the witness's public_key, and this witness has none on file.");

  // 3. The signature, over the preimage witness.mjs builds for this registry.
  const preimage = `${WITNESS_COUNTERSIGNATURE_PREFIX}:${origin}:${log}:${treeSize}:${root}`;
  let verified = false;
  try {
    verified = await verifyEd25519(b64urlDecode(witness.public_key), new TextEncoder().encode(preimage), b64urlDecode(witnessSig));
  } catch {
    verified = false;
  }
  if (!verified)
    return refuse(422, "witness_sig does not verify under this witness's public_key", `The signature must be Ed25519 over the UTF-8 bytes of ${WITNESS_COUNTERSIGNATURE_PREFIX}:<registry origin, no trailing slash>:<log>:<tree_size>:<root>, here ${preimage}`);

  // 4. The head is one this registry signed.
  const checkpoint = await env.DB.prepare("SELECT id, root FROM checkpoints WHERE log = ? AND tree_size = ?")
    .bind(log, treeSize)
    .first<{ id: number; root: string }>();
  if (!checkpoint || checkpoint.root !== root)
    return refuse(422, "not a checkpoint this registry signed", `${log} has no checkpoint at tree_size ${treeSize} with that root. GET /api/checkpoint serves the latest.`);

  // 5. Keep the newest per (witness, log).
  const stored = await env.DB.prepare(`SELECT ${STORED_COLUMNS} FROM witness_countersignatures WHERE witness_id = ? AND log = ?`)
    .bind(witnessId, log)
    .first<StoredRow>();
  if (stored) {
    const answer = answerForStored(stored, treeSize, root);
    if (answer) return answer;
  }

  // The receipt is signed before the write and stored with it, so the row and
  // the registry's word on received_at are one statement, never two.
  const signer = await registrySigner(env);
  const receivedAt = Date.now();
  const payload = `${WITNESS_RECEIPT_PAYLOAD_PREFIX}:${origin}:${witnessId}:${witness.epoch}:${log}:${treeSize}:${root}:${receivedAt}`;
  const receiptSig = await signer.sign(payload);
  // One statement whose WHERE keeps a concurrent larger row: two requests that
  // both read "nothing stored" cannot rewind the label by writing out of order.
  const written = await env.DB.prepare(
    `INSERT INTO witness_countersignatures (${STORED_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(witness_id, log) DO UPDATE SET
       tree_size = excluded.tree_size, root = excluded.root, witness_sig = excluded.witness_sig,
       witness_epoch = excluded.witness_epoch, checkpoint_id = excluded.checkpoint_id,
       received_at = excluded.received_at, receipt_payload = excluded.receipt_payload, receipt_sig = excluded.receipt_sig
     WHERE excluded.tree_size > witness_countersignatures.tree_size`,
  )
    .bind(witnessId, log, treeSize, root, witnessSig, witness.epoch, checkpoint.id, receivedAt, payload, receiptSig)
    .run();
  if (written.meta.changes === 0) {
    // A larger row landed between the read and the write: answer as if it had
    // been there first.
    const now = await env.DB.prepare(`SELECT ${STORED_COLUMNS} FROM witness_countersignatures WHERE witness_id = ? AND log = ?`)
      .bind(witnessId, log)
      .first<StoredRow>();
    const answer = now ? answerForStored(now, treeSize, root) : null;
    if (answer) return answer;
    return refuse(500, "the countersignature could not be stored", "The write changed no row and no stored row explains why; send it again.");
  }
  return {
    status: 201,
    body: {
      accepted: true,
      receipt: { payload, sig: receiptSig },
      registry_public_key: { kty: "OKP", crv: "Ed25519", x: signer.key },
      witness_id: witnessId,
      log,
      tree_size: treeSize,
    },
  };
}

// The stored row per (witness, log) for a page of witnesses. Every requested
// id has an entry (an empty object when it has pushed nothing), so a caller
// can .get(id) without a fallback. Read in chunks well under D1's limit on
// bound parameters.
export async function latestCountersignatures(env: Env, witnessIds: number[]): Promise<Map<number, Partial<Record<PushLog, CountersignedRow>>>> {
  const out = new Map<number, Partial<Record<PushLog, CountersignedRow>>>();
  for (const id of witnessIds) out.set(id, {});
  const CHUNK = 50;
  for (let i = 0; i < witnessIds.length; i += CHUNK) {
    const chunk = witnessIds.slice(i, i + CHUNK);
    const { results } = await env.DB.prepare(`SELECT ${STORED_COLUMNS} FROM witness_countersignatures WHERE witness_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<StoredRow>();
    for (const r of results) {
      const entry = out.get(r.witness_id);
      if (entry)
        entry[r.log] = {
          tree_size: r.tree_size,
          root: r.root,
          witness_sig: r.witness_sig,
          witness_epoch: r.witness_epoch,
          checkpoint_id: r.checkpoint_id,
          received_at: r.received_at,
          receipt: { payload: r.receipt_payload, sig: r.receipt_sig },
        };
    }
  }
  return out;
}

// Seconds from the OLDEST checkpoint of `log` past treeSize to nowMs, floored;
// 0 when there is none. A quiet log is not a dead witness: one holding the
// newest head is behind by nothing however long ago that head was stamped.
// Derived only from this registry's own checkpoints, so a reader recomputes it
// from GET /api/checkpoint. tree_size grows with id and created_at, so the
// smallest size above treeSize is the oldest such stamp, and the (log,
// tree_size) unique index answers it with a seek.
export async function lagSeconds(env: Env, log: string, treeSize: number, nowMs: number): Promise<number> {
  const row = await env.DB.prepare("SELECT created_at FROM checkpoints WHERE log = ? AND tree_size > ? ORDER BY tree_size ASC LIMIT 1")
    .bind(log, treeSize)
    .first<{ created_at: number }>();
  if (!row) return 0;
  return Math.max(0, Math.floor((nowMs - row.created_at) / 1000));
}
