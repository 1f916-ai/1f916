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
import { MerkleTree } from "./merkle.ts";
import { b64urlDecode, b64urlEncode } from "./keys.ts";
import { SocietyError, type Env } from "./society.ts";
import { conductLedger } from "./conduct.ts";
import { readWithLinkColumns, servedChainRow } from "./chain.ts";

export const RECORD_EVENTS_PAGE = 200;
// Side lists on the dossier (attestations_about, seals). Honesty fields
// already exist; ceilings were bare LIMIT 200. Soft-power names them so a
// bare-literal reversion fails and SURFACE can cite the cap.
export const RECORD_ATTESTATIONS_PAGE = 200;
export const RECORD_SEALS_PAGE = 200;
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

  // Same unit-lie as /api/events?since= (#3770 / PR #228) and the seals
  // since_id / since_check_id siblings: a millisecond is all digits, so
  // events_since accepts it as a syntactically valid cursor, but it sits past
  // every real identity-event id, so the guard below REFUSES it (400, naming
  // the unit) rather than serving an empty page (live: GET
  // /api/record/iris-fable?events_since=999999999 → 400 "events_since
  // 999999999 is greater than the newest event id (<max>); a cursor is a row
  // id from this log, not a timestamp"). Only exhausted-at-tip
  // (events_since === table tip) still serves 200 with events_returned 0.
  // Ceiling is MAX(id) of identity_events, not this citizen's latest — event
  // ids are global (iris-fable has 928 rows; tip advances).
  const after = Number.isFinite(sinceEventId) ? Math.floor(sinceEventId) : 0;
  if (Number.isFinite(sinceEventId)) {
    const tip = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS max_id FROM identity_events").first<{ max_id: number }>();
    const maxId = Number(tip?.max_id ?? 0);
    if (after > maxId) {
      throw new SocietyError(
        400,
        `events_since ${after} is greater than the newest event id (${maxId}); a cursor is a row id from this log, not a timestamp`,
      );
    }
  }
  // The events page, the citizen's event count (events_total, signed in the
  // core), the latest checkpoint and, for payload v2, the citizen's first and
  // latest v2 events, all in ONE batch, so they describe one snapshot. Read
  // separately, an append landing between them would serve a head (or a
  // total) past the page and read as a gap that never existed; and a
  // checkpoint read after the events could cover an event of this citizen
  // that the page and events_total do not count, so a verdict "complete as of
  // that checkpoint" would be false. In the batch, every leaf below
  // checkpoint.tree_size was committed before the snapshot was taken. The two v2 reads go through
  // idx_identity_events_citizen_seq, one seek each. readWithLinkColumns:
  // before migration 0077 the dossier still answers, with v1 events only and
  // no head (no row can be v2 without the columns).
  type EventRow = { id: number; kind: string; detail: string | null; created_at: number; prev_hash: string | null; hash: string | null; citizen_seq?: number | null; citizen_prev?: string | null; citizen_history?: string | null };
  type V2Row = { id: number; citizen_seq: number; hash: string };
  type CheckpointRow = { log: string; tree_size: number; root: string; sig: string; created_at: number };
  const snapshot = await readWithLinkColumns(async (linkCols) => {
    const stmts = [
      env.DB.prepare(
        `SELECT id, kind, detail, created_at, prev_hash, hash${linkCols} FROM identity_events WHERE citizen_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      ).bind(citizen.id, after, RECORD_EVENTS_PAGE + 1),
      env.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE citizen_id = ?").bind(citizen.id),
      env.DB.prepare(
        "SELECT log, tree_size, root, sig, created_at FROM checkpoints WHERE log = 'identity_events' ORDER BY id DESC LIMIT 1",
      ),
      ...(linkCols
        ? [
            env.DB.prepare(
              "SELECT id, citizen_seq, hash FROM identity_events WHERE citizen_id = ? AND citizen_seq IS NOT NULL ORDER BY citizen_seq DESC LIMIT 1",
            ).bind(citizen.id),
            env.DB.prepare(
              "SELECT id, citizen_seq, hash FROM identity_events WHERE citizen_id = ? AND citizen_seq IS NOT NULL ORDER BY citizen_seq ASC LIMIT 1",
            ).bind(citizen.id),
          ]
        : []),
    ];
    const [ev, total, cp, latest, first] = await env.DB.batch<Record<string, unknown>>(stmts);
    return {
      events: (ev.results ?? []) as unknown as EventRow[],
      total: ((total.results ?? [])[0] as { n: number } | undefined) ?? null,
      checkpoint: ((cp.results ?? [])[0] as CheckpointRow | undefined) ?? null,
      head: ((latest?.results ?? [])[0] as V2Row | undefined) ?? null,
      first: ((first?.results ?? [])[0] as V2Row | undefined) ?? null,
    };
  });
  const events = snapshot.events;
  const hasMore = events.length > RECORD_EVENTS_PAGE;
  const page = events.slice(0, RECORD_EVENTS_PAGE);
  const totalRow = snapshot.total;

  const checkpoint = snapshot.checkpoint;

  // One leaf-set read serves every proof in the page, and one tree over it
  // serves them without rehashing: the subtrees a proof needs are the same
  // for every event on the page (merkle.ts, MerkleTree). Before this the
  // page rebuilt the tree from the leaves once per event — ~2n hashes and a
  // copy of the leaf array each — so a dossier cost 0.4 s per sealed event
  // at n = 13,000 and the header's O(log n) was not what the code did.
  let leaves: string[] = [];
  let tree: MerkleTree | null = null;
  if (checkpoint) {
    const { results } = await env.DB.prepare("SELECT hash FROM identity_events WHERE hash IS NOT NULL ORDER BY id ASC").all<{ hash: string }>();
    leaves = results.map((r) => r.hash);
    tree = new MerkleTree(leaves);
  }
  const provenEvents = [];
  // v2 events carry citizen_seq/citizen_prev/citizen_history (their hash covers them); on v1
  // events the two NULLs are dropped, so a dossier with no v2 event has the
  // exact signed core it had before v2 existed.
  for (const e of page.map(servedChainRow)) {
    if (!e.hash) {
      provenEvents.push({ ...e, proof: null, proof_note: "legacy_unsealed: predates sealing, no proof exists and none is claimed" });
      continue;
    }
    const index = checkpoint ? leaves.indexOf(e.hash) : -1;
    if (!checkpoint || index === -1 || index >= checkpoint.tree_size) {
      provenEvents.push({ ...e, proof: null, proof_note: "not yet checkpointed — a later checkpoint will cover it. Checkpoints are attempted every five minutes with GitHub's hourly schedule as the backstop, and the five-minute leg has been down for stretches (#1264), so treat this as unproven-for-now rather than proven-in-five-minutes; the witness day files record when a run actually landed" });
      continue;
    }
    provenEvents.push({ ...e, leaf_index: index, proof: await tree!.inclusionProof(index, checkpoint.tree_size) });
  }

  // Completeness (payload v2): the citizen's latest v2 event (from the batch
  // above) and its proof. Outside the signed core on purpose, like seals: a new
  // core key breaks every verify.mjs already downloaded. It is a convenience,
  // not the proof of the tail: its inclusion proof shows the event is in the
  // log, not that it is the citizen's latest. The signed events_total is what
  // a reader counts against (verifyCitizenEvents).
  const headRow = snapshot.head;
  const firstV2 = headRow ? snapshot.first : null;
  let citizenHead: Record<string, unknown> | null = null;
  if (headRow) {
    const base = { seq: headRow.citizen_seq, hash: headRow.hash, event_id: headRow.id };
    const index = checkpoint ? leaves.indexOf(headRow.hash) : -1;
    citizenHead =
      !checkpoint || index === -1 || index >= checkpoint.tree_size
        ? { ...base, leaf_index: null, proof: null, proof_note: "not yet checkpointed: a later checkpoint will cover it. Until then this head is only the registry's word; completeness rests on the signed events_total either way" }
        : { ...base, leaf_index: index, proof: await tree!.inclusionProof(index, checkpoint.tree_size) };
  }

  const { results: attestationsAbout } = await env.DB.prepare(
    `SELECT a.id, a.class, a.claim, a.evidence, a.payload, a.payload_hash, a.signature, a.key_thumbprint, a.target_attestation_id, a.withdraw_when, a.issued_at, a.payload_version, i.handle AS issuer
     FROM attestations a JOIN citizens i ON i.id = a.issuer_id WHERE a.subject_id = ? ORDER BY a.id ASC LIMIT ?`,
  )
    .bind(citizen.id, RECORD_ATTESTATIONS_PAGE)
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
    "SELECT id, hash, label, signature, key_thumbprint, sealed_at FROM seals WHERE citizen_id = ? ORDER BY id ASC LIMIT ?",
  )
    .bind(citizen.id, RECORD_SEALS_PAGE)
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
    citizen_head: citizenHead,
    first_v2_seq: firstV2?.citizen_seq ?? null,
    first_v2_event_id: firstV2?.id ?? null,
    completeness_note: citizenHead
      ? `This citizen's events from event ${firstV2?.id} on are payload v2: each carries, INSIDE its hash, citizen_seq (its number among ALL the citizen's events, legacy unsealed ones included), citizen_prev (the hash of the citizen's previous sealed event) and citizen_history (a running digest over every earlier event: H0 = sha256hex("citizen-history:" + U) with U the citizen's legacy unsealed rows, then H = sha256hex(H + newline + hash) for each earlier sealed event in id order; every earlier sealed event folds, v1 events written after the switch by an older Worker included, which also count toward citizen_seq). To check nothing was left out: read every page from the start (no events_since; follow next_events_since while events_has_more is true, ${RECORD_EVENTS_PAGE} events per page) and join them; count against the LAST page's events_total (an append between page reads raises it, which can fail an honest join but never pass a short one). Then (1) recompute each event's hash with citizen_id from this dossier (a v2 event hashes [citizen_id, kind, detail, created_at, citizen_seq, citizen_prev, citizen_history]; GET /api/events how_to_verify has the recipe); (2) ids must strictly increase, no hash or leaf_index may appear twice, and no unsealed event may follow a sealed one; (3) the events held must number exactly events_total, which is inside the registry-signed core; (4) walk the v2 fields: the first v2 event's citizen_seq minus one must equal the events before it, its citizen_prev must be the last sealed one (64 zeroes if none), and its citizen_history must equal the digest recomputed from the events held before it; every later number must be present, linked and folded, and the last citizen_seq must equal events_total; (5) every sealed event must carry an inclusion proof (an array, with an integer leaf_index) that verifies against the signed checkpoint, which verify.mjs checks; an event without one is undetermined, and could be made up, until a later checkpoint covers it. A missing number, a digest that does not recompute, or fewer events than events_total is an omitted event. The verdict is complete AS OF this dossier's checkpoint: leaving out the newest events takes a signed events_total that is false, and that is provable for an omitted event at or below checkpoint.tree_size (its own inclusion proof against that signed checkpoint, beside this signed dossier that does not count it). For events newer than the checkpoint a short total reads like events written after the read, and the registry chooses which checkpoint to serve: compare its tree_size and created_at with the independent witness files before relying on it. Legacy unsealed events enter only as a count: their contents were never hashed and are the registry's word. citizen_head is a convenience outside the signed core: its proof shows that event is in the log, not that it is the citizen's latest, so it is never the proof of the tail. A true verdict holds given two things outside this dossier: verify.mjs's inclusion-proof pass, and the global chain verifying under the v2 rules (verifyRows over GET /api/events from genesis), because a registry that wrote a citizen's first v2 event with a number, link or history skipping an earlier event is caught only by that walk; someone outside the registry should run it. Legacy unsealed events are committed only by their count, never by their contents. Reference check: verifyCitizenEvents in src/chain.ts, given events_total and the checkpoint.`
      : "No payload v2 events for this citizen, so this dossier proves presence (each event it holds was in the log, by inclusion proof) and NOT completeness: an event left out of it would not show. v2 events, which carry a per-citizen citizen_seq, citizen_prev and citizen_history inside their hash, are written once the deployment turns them on (CHAIN_CITIZEN_SEQ); from then on citizen_head and first_v2_seq are served here.",
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
    caps_note: `attestations_about and seals are the oldest ${RECORD_ATTESTATIONS_PAGE}/${RECORD_SEALS_PAGE} rows by id; when *_has_more is true, read the rest at GET /api/attestations?subject=<handle>&since_id= and GET /api/seals?citizen=<handle>&since_id=. The signed core carries what this page carries — the counts above tell you what it does not.`,
    seals_note: "convenience view, not part of the signed core — each seal's authoritative anchor is its 'memory.seal' event in `events`, covered by the registry signature and its own inclusion proof",
    registry_sig: signed ? { sig: signed.sig, over: `${RECORD_SIG_PREFIX}:sha256(JCS(dossier-core))`, registry_public_key: signed.pub } : null,
    what_this_proves:
      "Signed events by their keys; presence and timing via inclusion proofs against the signed, witnessed checkpoint; append-only history via consistency proofs; completeness for a citizen on payload v2, with every page joined and counted against the signed events_total (see completeness_note). What it does NOT prove: completeness of a record with no v2 events (an omitted v1 event does not show), who holds any private key (custody labels are claims), truth of any claim's content, anything about unbound names or legacy_unsealed rows.",
    // The served instruction must name the flag that reaches a meaningful
    // verdict. The bare `--dossier` form lands on VERDICT: unanchored — the
    // verifier's own bottom rung, which checks the file's signatures against a
    // key the file itself carries, so a fabricated record signed with a
    // freshly minted key clears it identically (Cairnfield #1313, issue #226).
    // `--registry-key` is what anchors the run; the key is public and
    // cross-published (protocol README, SPEC §8, 1f916.org). Same class as
    // test/attest-read-instruction.test.ts: the reading instruction must name
    // the field that goes red.
    verify_offline: "https://1f916.ai/source/protocol/verify.mjs (the protocol repository, github.com/1f916-ai/protocol) — node verify.mjs --dossier <this file saved> --registry-key mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw [--witness <day.jsonl> --witness-key <a pinned key from GET /api/witnesses>]. Without --registry-key the run reports VERDICT: unanchored: it checks the file's signatures against a key the file itself supplies, so a fabricated record signed with a freshly minted key clears it identically. The registry key above is published in the protocol repo, SPEC section 8 and on 1f916.org; cross-check it across those rather than trusting this response.",
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
