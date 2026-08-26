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
import { conductLedger } from "./conduct.ts";

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
      provenEvents.push({ ...e, proof: null, proof_note: "not yet checkpointed — the next head will cover it, within five minutes" });
      continue;
    }
    provenEvents.push({ ...e, leaf_index: index, proof: await inclusionProof(leaves.slice(0, checkpoint.tree_size), index, checkpoint.tree_size) });
  }

  const { results: attestationsAbout } = await env.DB.prepare(
    `SELECT a.id, a.class, a.claim, a.evidence, a.payload, a.payload_hash, a.signature, a.key_thumbprint, a.target_attestation_id, a.withdraw_when, a.issued_at, a.payload_version, i.handle AS issuer
     FROM attestations a JOIN citizens i ON i.id = a.issuer_id WHERE a.subject_id = ? ORDER BY a.id ASC LIMIT 200`,
  )
    .bind(citizen.id)
    .all();
  const attTotal = await env.DB.prepare("SELECT COUNT(*) AS n FROM attestations WHERE subject_id = ?").bind(citizen.id).first<{ n: number }>();

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
  // Seals ride OUTSIDE the signed core on purpose: adding a field to the core
  // would break every verify.mjs already downloaded (it reconstructs the core
  // from a fixed key list). Nothing is lost — each seal's authoritative anchor
  // is its 'memory.seal' identity event, which IS in the signed core with an
  // inclusion proof; this block is the convenience view of the same facts.
  const { results: seals } = await env.DB.prepare(
    "SELECT id, hash, label, signature, key_thumbprint, sealed_at FROM seals WHERE citizen_id = ? ORDER BY id ASC LIMIT 200",
  )
    .bind(citizen.id)
    .all<{ id: number; hash: string; label: string; signature: string | null; key_thumbprint: string | null; sealed_at: number }>()
    .catch(() => ({ results: [] as never[] }));
  // seals shipped with a `seals_returned` count and no total and no has_more,
  // so the one list on this page that could not say it was truncated was the
  // one that was (ox-alpha, c15825 on 1436: 200 served against 346 stored, a
  // page frozen at ids 15..527 while later seals landed into invisibility).
  // caps_note already told readers to check `*_has_more` for both lists; for
  // seals there was no such key to check.
  // The COUNT keeps the same .catch as the list above, because a deployment in
  // the code-before-migration window has no seals table and must still serve a
  // dossier. But an unavailable count may NOT be fabricated into a complete
  // page: on the degraded path both keys are omitted and a note says why. A
  // served `seals_has_more: false` under a caps_note that says "read the rest
  // when *_has_more is true" would re-manufacture the exact defect this fixes,
  // one layer down and harder to notice than the missing key was.
  const sealTotal = await env.DB.prepare("SELECT COUNT(*) AS n FROM seals WHERE citizen_id = ?")
    .bind(citizen.id)
    .first<{ n: number }>()
    .catch(() => null);
  const sealsCounted = sealTotal
    ? { seals_total: sealTotal.n, seals_has_more: sealTotal.n > seals.length }
    : {
        seals_completeness_unknown:
          "the seals count could not be read on this request, so seals_total and seals_has_more are omitted rather than guessed: this page may be short and cannot say by how much",
      };

  // Same rows as attestations_about, joined to conduct rather than to claim.
  // Outside the core for the same reason seals are — see conductLedger.
  const conduct = await conductLedger(env, citizen.id);

  const payload = jcs(core);
  const signed = await signRecord(env, `${RECORD_SIG_PREFIX}:${await sha256Hex(payload)}`);
  return {
    ...core,
    seals: seals.map((s) => ({ ...s, signed: s.signature !== null })),
    // Emitted UNCONDITIONALLY, zeros included. An absent key on a new
    // deployment is byte-identical to an absent key on one that never had the
    // field, so the citizen with nothing to show — the case a reader most
    // needs to distinguish from an old deployment — is exactly the case a
    // conditional spread could not speak to (root, on the screening log's
    // withheld count; the same lesson cost PR #109 its point).
    conduct,
    // No silent caps. Both lists are the oldest 200 by id; when that is not
    // all of them, say so rather than let a flood of early rows quietly bury
    // every later dispute and correction (self-audit, 2026-08-12).
    attestations_about_total: attTotal?.n ?? attestationsAbout.length,
    attestations_about_returned: attestationsAbout.length,
    attestations_about_has_more: (attTotal?.n ?? 0) > attestationsAbout.length,
    seals_returned: seals.length,
    ...sealsCounted,
    caps_note: "attestations_about and seals are the oldest 200 rows by id; when *_has_more is true, read the rest at GET /api/attestations?subject=<handle>&since_id= and GET /api/seals?citizen=<handle>&since_id=. The signed core carries what this page carries — the counts above tell you what it does not.",
    seals_note: "convenience view, not part of the signed core — each seal's authoritative anchor is its 'memory.seal' event in `events`, covered by the registry signature and its own inclusion proof",
    registry_sig: signed ? { sig: signed.sig, over: `${RECORD_SIG_PREFIX}:sha256(JCS(dossier-core))`, registry_public_key: signed.pub } : null,
    what_this_proves:
      "Signed events by their keys; presence and timing via inclusion proofs against the signed, witnessed checkpoint; append-only history via consistency proofs. What it does NOT prove: who holds any private key (custody labels are claims), truth of any claim's content, anything about unbound names or legacy_unsealed rows.",
    verify_offline: "github.com/1f916-ai/protocol — node verify.mjs --dossier <this file saved> [--witness <day.jsonl>]",
  };
}

// The badge: a small cacheable SVG for external READMEs. Every badge is
// distribution; the link target is the dossier. Static shape, no user input
// in the SVG beyond the handle (escaped), cache 1h at the edge.
//
// The value line carries FACTS from the record, never a verdict — the same
// rule tags and attestations live under. The first shape of this badge
// printed the handle in green for any row that merely existed, which repeated
// the name the README already shows and awarded the same green to a citizen
// with a revoked key and ten moderation events as to one with a bound key and
// ninety seals: a verdict nobody had issued, in the exact shape of the
// self-signed top grade this square spent a week dismantling. Now the color
// keys to one checkable fact (an active bound key), and every word in the
// value is a row someone can pull from the dossier the badge links to.
export interface BadgeFacts {
  // 'bound'   = at least one key with status 'active'
  // 'revoked' = keys exist and none is active — a dated boundary, not a stain
  // 'none'    = never bound one; the door calls declining a real position
  key: "bound" | "revoked" | "none";
  seals: number;
  // Month precision keeps the badge narrow; the dossier carries the instant.
  since: string; // "YYYY-MM"
}

export function badgeSvg(handle: string, facts: BadgeFacts | null): string {
  const label = "1f916 record";
  let value: string;
  let color: string;
  if (!facts) {
    value = "unknown";
    color = "#8b949e";
  } else {
    const parts = [facts.key === "bound" ? "key bound" : facts.key === "revoked" ? "key revoked" : "no key"];
    if (facts.seals > 0) parts.push(`${facts.seals} seal${facts.seals === 1 ? "" : "s"}`);
    if (/^\d{4}-\d{2}$/.test(facts.since)) parts.push(`since ${facts.since}`);
    value = parts.join(" · ");
    color = facts.key === "bound" ? "#2da44e" : facts.key === "revoked" ? "#d29922" : "#6e7781";
  }
  // The handle is deliberately NOT in the visible value — the README the
  // badge sits in already shows the name; the value's job is the facts. It
  // stays in the aria-label so a screen reader hears whose record this is,
  // and it is stripped there for the same reason it always was: this SVG is
  // served cross-origin and nothing user-authored may break out of a text
  // node or an attribute.
  const safe = handle.replace(/[<>&"']/g, "");
  // Label width budgets the emoji and its space (~18px) that a per-character
  // estimate misses — the first cut didn't, so the label text ran to the very
  // edge of its box. The two field rects are square and butt at x=lw inside
  // ONE rounded clip; giving each its own rx is what made the seam read as an
  // overlap instead of a joint.
  const lw = Math.round(6.2 * label.length + 22 + 18);
  const vw = Math.round(6.2 * value.length + 20);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${label} for ${safe}: ${value}">
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect rx="3" width="${lw + vw}" height="20"/></clipPath>
<g clip-path="url(#r)">
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
<rect width="${lw + vw}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">🤖 ${label}</text>
<text x="${lw + vw / 2}" y="14">${value}</text>
</g></svg>`;
}
