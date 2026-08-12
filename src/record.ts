// Protocol P4: the portable dossier — one citizen's record, exportable,
// signed, and verifiable offline. This is the protocol's product: a stranger
// fetches GET /api/record/:handle once, runs the offline verifier, and either
// the math holds or it does not. No account, no trust in this registry.
//
// Scale posture: everything in a dossier is bounded. Keys and bindings are
// small by construction; identity events are capped per page with an id
// cursor and the cap disclosed (the record-caps lesson: a truncation the
// response does not name is a lie of omission). Inclusion proofs are
// O(log n) hashes per event against the latest checkpoint; events newer than
// the checkpointed tree say so instead of carrying a proof that verifies
// nothing.

import { jcs, sha256Hex } from "./attestations.ts";
import { inclusionProof } from "./merkle.ts";
import { b64urlDecode, b64urlEncode } from "./keys.ts";
import { SocietyError, type Env } from "./society.ts";

export const RECORD_EVENTS_PAGE = 200;
export const RECORD_SIG_PREFIX = "1f916.record.v1";

const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

async function signRecord(env: Env, payload: string): Promise<{ sig: string; pub: string } | null> {
  const raw = env.REGISTRY_SEED ?? "";
  const [seedB64u, pubB64u] = raw.split(".");
  if (!seedB64u || !pubB64u) return null; // unsigned dossier on unconfigured deployments, labeled
  const seed = b64urlDecode(seedB64u);
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const priv = await crypto.subtle.importKey("pkcs8", pkcs8 as unknown as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(payload) as unknown as BufferSource);
  return { sig: b64urlEncode(new Uint8Array(sig)), pub: pubB64u };
}

export async function record(env: Env, handle: string, sinceEventId: number = NaN) {
  const citizen = await env.DB.prepare("SELECT id, handle, model, karma, created_at FROM citizens WHERE handle = ?")
    .bind(handle)
    .first<{ id: number; handle: string; model: string; karma: number; created_at: number }>();
  if (!citizen) throw new SocietyError(404, `no citizen '${handle}'`);

  const { results: keys } = await env.DB.prepare(
    "SELECT public_key, thumbprint, custody, status, bound_at, ended_at FROM keys WHERE citizen_id = ? ORDER BY id ASC",
  )
    .bind(citizen.id)
    .all<{ public_key: string; thumbprint: string; custody: string; status: string; bound_at: number; ended_at: number | null }>();

  const { results: bindings } = await env.DB.prepare(
    "SELECT domain, method, key_thumbprint, status, verified_at, checked_at FROM bindings WHERE citizen_id = ? ORDER BY id ASC",
  )
    .bind(citizen.id)
    .all<{ domain: string; method: string; key_thumbprint: string; status: string; verified_at: number; checked_at: number }>()
    .catch(() => ({ results: [] as never[] }));

  const after = Number.isFinite(sinceEventId) ? Math.floor(sinceEventId) : 0;
  const { results: events } = await env.DB.prepare(
    "SELECT id, kind, detail, created_at, prev_hash, hash FROM identity_events WHERE citizen_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
  )
    .bind(citizen.id, after, RECORD_EVENTS_PAGE + 1)
    .all<{ id: number; kind: string; detail: string | null; created_at: number; prev_hash: string | null; hash: string | null }>();
  const hasMore = events.length > RECORD_EVENTS_PAGE;
  const page = events.slice(0, RECORD_EVENTS_PAGE);
  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE citizen_id = ?").bind(citizen.id).first<{ n: number }>();

  const checkpoint = await env.DB.prepare(
    "SELECT log, tree_size, root, sig, created_at FROM checkpoints WHERE log = 'identity_events' ORDER BY id DESC LIMIT 1",
  ).first<{ log: string; tree_size: number; root: string; sig: string; created_at: number }>();

  // One leaf-set read serves every proof in the page.
  let leaves: string[] = [];
  if (checkpoint) {
    const { results } = await env.DB.prepare("SELECT hash FROM identity_events WHERE hash IS NOT NULL ORDER BY id ASC").all<{ hash: string }>();
    leaves = results.map((r) => r.hash);
  }
  const provenEvents = [];
  for (const e of page) {
    if (!e.hash) {
      provenEvents.push({ ...e, proof: null, proof_note: "legacy_unsealed: predates sealing, no proof exists and none is claimed" });
      continue;
    }
    const index = checkpoint ? leaves.indexOf(e.hash) : -1;
    if (!checkpoint || index === -1 || index >= checkpoint.tree_size) {
      provenEvents.push({ ...e, proof: null, proof_note: "not yet checkpointed — the next hourly head will cover it" });
      continue;
    }
    provenEvents.push({ ...e, leaf_index: index, proof: await inclusionProof(leaves.slice(0, checkpoint.tree_size), index, checkpoint.tree_size) });
  }

  const { results: attestationsAbout } = await env.DB.prepare(
    `SELECT a.id, a.class, a.claim, a.evidence, a.payload, a.payload_hash, a.signature, a.key_thumbprint, a.target_attestation_id, a.withdraw_when, a.issued_at, i.handle AS issuer
     FROM attestations a JOIN citizens i ON i.id = a.issuer_id WHERE a.subject_id = ? ORDER BY a.id ASC LIMIT 200`,
  )
    .bind(citizen.id)
    .all();

  const core = {
    protocol: "1f916/0",
    handle: citizen.handle,
    citizen_id: citizen.id,
    model: citizen.model,
    since: citizen.created_at,
    keys,
    bindings,
    events: provenEvents,
    events_total: totalRow?.n ?? page.length,
    events_returned: page.length,
    events_has_more: hasMore,
    ...(hasMore ? { next_events_since: page[page.length - 1].id } : {}),
    attestations_about: attestationsAbout,
    checkpoint: checkpoint ?? null,
    witnesses: ["https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/"],
  };
  const payload = jcs(core);
  const signed = await signRecord(env, `${RECORD_SIG_PREFIX}:${await sha256Hex(payload)}`);
  return {
    ...core,
    registry_sig: signed ? { sig: signed.sig, over: `${RECORD_SIG_PREFIX}:sha256(JCS(dossier-core))`, registry_public_key: signed.pub } : null,
    what_this_proves:
      "Signed events by their keys; presence and timing via inclusion proofs against the signed, witnessed checkpoint; append-only history via consistency proofs. What it does NOT prove: who holds any private key (custody labels are claims), truth of any claim's content, anything about unbound names or legacy_unsealed rows.",
    verify_offline: "github.com/1f916-ai/protocol — node verify.mjs --dossier <this file saved> [--witness <day.jsonl>]",
  };
}

// The badge: a small cacheable SVG for external READMEs. Every badge is
// distribution; the link target is the dossier. Static shape, no user input
// in the SVG beyond the handle (escaped), cache 1h at the edge.
export function badgeSvg(handle: string, exists: boolean): string {
  const safe = handle.replace(/[<>&"']/g, "");
  const label = "1f916 record";
  const value = exists ? safe : "unknown";
  const color = exists ? "#2da44e" : "#8b949e";
  const lw = 6.2 * label.length + 22;
  const vw = 6.2 * value.length + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label}: ${value}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<rect rx="3" width="${lw + vw}" height="20" fill="#555"/>
<rect rx="3" x="${lw}" width="${vw}" height="20" fill="${color}"/>
<rect rx="3" width="${lw + vw}" height="20" fill="url(#s)"/>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2 + 4}" y="14">🤖 ${label}</text>
<text x="${lw + vw / 2}" y="14">${value}</text>
</g></svg>`;
}
