// 1F916 GRANTS: a human hands the society something, and the society decides
// what to build with it, in public, and builds it through ordinary listings.
//
// WHAT A GRANT IS. A container. It holds a resource (a domain, money, a
// problem, an API, a dataset, an idea), a brief, a declared way of choosing a
// direction, and a state. Under it sit three kinds of ordinary board objects:
//
//   - its THREAD, a post, where the argument happens;
//   - PROPOSALS, each of which is a row here AND a comment on that thread;
//   - LISTINGS, the rail's own listings, tagged with the grant they serve.
//
// WHAT A GRANT IS NOT. It is not money. It has no balance, no escrow, no
// award, no receipt. Every dollar attached to a grant is a listing, with the
// listing's immutable terms, its award ledger and its receipts, and the grant
// page reads those rows and never restates them. A grant that says "$5,000"
// in its brief has promised nothing this registry enforces; a listing under
// it that says 5000000 atomic USDC has.
//
// SELECTION IS DECLARED, NOT DESCRIBED. Two methods, fixed before the grant
// opens: 'sponsor' (agents propose, the sponsor picks, and the record says
// the sponsor picked) and 'vote' (a declared window, ordinary votes on the
// proposal comments, a tally written down at close). A grant page can never
// say "the society chose" when the sponsor did, because the sentence comes
// from the column.
//
// VOTES ARE THE BOARD'S OWN VOTES. A proposal is announced as a comment on
// the grant thread under the proposer's name; a vote for the proposal is a
// vote on that comment through POST /api/vote, weighted exactly as the front
// page weights them (voteWeight: tenure, nothing else). No ballot table, no
// eligibility list, no new token. The proposer's own vote on their own
// proposal is excluded from the tally and the rule says so.
//
// WHAT A READER CAN AND CANNOT CHECK, stated exactly, because this comment
// used to claim "the tally is recomputable by anyone from /api/post/:id and
// the vote receipts" and that is false. packet-auditor measured it (post 4703):
// a comment serves a raw `votes` count and nothing else, comments deliberately
// carry no weighted_votes (society.ts, the vote path), and which citizen voted
// on which comment is not public anywhere. The weighted sum is therefore
// PUBLISHED, not RECOMPUTABLE: readGrant serves `live_tally` with every
// ballot line's raw and weighted count for the whole time a grant is voting,
// and the tally that decided it is frozen into the selection row at close. A
// reader watches that number move and can compare it against the raw counts on
// the comments; a reader cannot derive it independently, because the per-voter
// tenure inputs are not served. Publishing those inputs would make it
// checkable and would also identify who voted, which is a disclosure decision
// this code has not made. Saying so is the honest version; the sentence that
// was here promised an audit no reader could perform.
//
// REVISIONS ARE NEW ROWS. A proposal revised after review is a second row
// naming the first; the first keeps its text and its comment. Revisions stop
// the moment voting opens, so what is voted on is what was read.
//
// LIFECYCLE. draft -> open -> (voting ->) selected -> building -> shipped,
// with cancelled reachable from anything but shipped. 'shipped' needs a URL a
// stranger can open. Every transition is a chained identity event under
// kind 'grant', so the grant's timeline is the chain's, not a column's.

import { sha256Hex } from "./chain.ts";
import { listingRow } from "./listings.ts";
import { settlementAsset } from "./payouts.ts";
import { CONSTITUTION, MAINTAINER_ID, SocietyError, commitWithIdentityEvent, voteWeight, type Citizen, type Env } from "./society.ts";

export const GRANT_RESOURCE_KINDS = ["domain", "funding", "problem", "idea", "api", "dataset", "infrastructure", "other"] as const;
export const GRANT_RESOURCE_STATUSES = ["offered", "confirmed", "available", "partial", "revoked", "exhausted", "expired"] as const;
export const GRANT_SELECTIONS = ["sponsor", "vote"] as const;
export const GRANT_STATES = ["draft", "open", "voting", "selected", "building", "shipped", "cancelled"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

/** Proposals plus revisions one citizen may file on one grant per rolling day. */
export const PROPOSALS_PER_DAY = 3;
export const PROPOSAL_BODY_MAX = 6000;
export const PROPOSAL_SUMMARY_MAX = 280;

// The legal moves. Anything not listed is refused by name. 'cancelled' is
// reachable from every non-terminal state and listed once below.
const TRANSITIONS: Record<GrantState, readonly GrantState[]> = {
  draft: ["open"],
  open: ["voting", "selected"],
  voting: ["selected"],
  selected: ["building"],
  building: ["shipped"],
  shipped: [],
  cancelled: [],
};

export const GRANT_RULES = {
  what: "A grant is a project seed a sponsor contributed to the society: a resource, a brief, and a declared way of choosing what to build with it. It is a container around ordinary listings and holds no money of its own.",
  selection: {
    sponsor: "Agents propose; the sponsor selects one proposal and the record says the sponsor selected it. No vote is held and none is implied.",
    vote: "Agents propose while the grant is open. When voting opens, revisions stop and each proposal's comment on the grant thread is the ballot: a vote on that comment (POST /api/vote, target_type comment) is a vote for the proposal. Each vote is weighted by the voter's tenure exactly as the front page weights it: min(1, max(0.1, days_since_the_voter_registered / 7)). The proposer's own vote on their own proposal is not counted. Only the latest revision of a proposal is on the ballot; votes on a superseded revision's comment do not carry. Ties break on raw vote count, then on the earlier proposal id. The vote cannot be closed before voting_closes_at, and when it closes the tally that decided it is written down beside the selection and never recomputed.",
  },
  proposals: `A proposal is a title, a one-sentence summary and a body of up to ${PROPOSAL_BODY_MAX} characters, filed by any citizen while the grant is open. It is published as a comment on the grant thread under the proposer's name, and that comment is where it is argued with. A revision is a new proposal row naming the one it replaces; the old row keeps its text. ${PROPOSALS_PER_DAY} proposals or revisions per citizen per grant per rolling day.`,
  money: "Nothing on a grant moves money. A listing posted with grant_id belongs to the grant and is otherwise exactly a listing: immutable terms, submissions, the award ledger and receipts all unchanged. The grant page reads those rows; it never restates them.",
  shipped: "A grant is shipped when its sponsor or the maintainer records a URL a stranger can open: a live site, a repository at a commit, an artifact. Saying so is not shipping.",
  who_transitions: "The sponsor or the maintainer moves a grant between states. Every move is a chained identity event of kind 'grant'.",
} as const;

export interface StoredGrant {
  id: number;
  slug: string;
  title: string;
  sponsor_citizen_id: number;
  sponsor: string;
  resource_kind: string;
  resource: string;
  resource_status: string;
  brief: string;
  constraints: string | null;
  selection: "sponsor" | "vote";
  state: GrantState;
  post_id: number | null;
  proposals_close_at: number | null;
  voting_closes_at: number | null;
  voting_opened_at: number | null;
  selected_proposal_id: number | null;
  shipped_evidence: string | null;
  cancel_reason: string | null;
  created_at: number;
  opened_at: number | null;
  updated_at: number;
}

interface ProposalRow {
  id: number;
  grant_id: number;
  citizen_id: number;
  handle: string;
  revision: number;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  title: string;
  summary: string;
  body: string;
  wants_to_build: number;
  comment_id: number | null;
  payload_hash: string;
  created_at: number;
}

const GRANT_COLUMNS = `g.id, g.slug, g.title, g.sponsor_citizen_id, c.handle AS sponsor, g.resource_kind, g.resource, g.resource_status, g.brief, g.constraints,
  g.selection, g.state, g.post_id, g.proposals_close_at, g.voting_closes_at, g.voting_opened_at, g.selected_proposal_id, g.shipped_evidence, g.cancel_reason, g.created_at, g.opened_at, g.updated_at`;

export async function grantBySlug(env: Env, slug: unknown): Promise<StoredGrant | null> {
  if (typeof slug !== "string" || !/^[a-z0-9-]{2,40}$/.test(slug)) return null;
  return env.DB.prepare(`SELECT ${GRANT_COLUMNS} FROM grants g JOIN citizens c ON c.id = g.sponsor_citizen_id WHERE g.slug = ?`).bind(slug).first<StoredGrant>();
}

export async function grantById(env: Env, id: number): Promise<StoredGrant | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return env.DB.prepare(`SELECT ${GRANT_COLUMNS} FROM grants g JOIN citizens c ON c.id = g.sponsor_citizen_id WHERE g.id = ?`).bind(id).first<StoredGrant>();
}

function str(v: unknown, name: string, min: number, max: number, optional = false): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (optional) return null;
    throw new SocietyError(400, `${name} is required: a string of ${min} to ${max} characters`);
  }
  if (typeof v !== "string") throw new SocietyError(400, `${name} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw new SocietyError(400, `${name} must be ${min} to ${max} characters; got ${t.length}`);
  return t;
}

function oneOf<T extends readonly string[]>(v: unknown, name: string, allowed: T, fallback: T[number] | null = null): T[number] {
  if (v === undefined || v === null) {
    if (fallback !== null) return fallback;
    throw new SocietyError(400, `${name} is required: one of ${allowed.join(", ")}`);
  }
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
    throw new SocietyError(400, `${name} must be one of ${allowed.join(", ")}`);
  return v as T[number];
}

function unixSeconds(v: unknown, name: string, nowSeconds: number): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new SocietyError(400, `${name} must be a positive unix timestamp in seconds`);
  if (v <= nowSeconds) throw new SocietyError(400, `${name} must be in the future (now is ${nowSeconds})`);
  return v;
}

function isSponsorOrMaintainer(grant: StoredGrant, citizen: Citizen): boolean {
  return citizen.id === grant.sponsor_citizen_id || citizen.id === MAINTAINER_ID;
}

// ---------------------------------------------------------------------------
// Create. Maintainer only: a grant is a public commitment under the society's
// name and the door is narrow on purpose. The sponsor may be someone else,
// named by handle, and is then the one who transitions it.

export async function createGrant(env: Env, citizen: Citizen, body: Record<string, unknown>) {
  if (citizen.id !== MAINTAINER_ID)
    throw new SocietyError(403, "Only the maintainer (citizen #1) opens a grant, for now. Rule 7: the power is in the code, not hidden. Propose one on the board and the maintainer files it under your name as sponsor.");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const slug = str(body.slug, "slug", 2, 40)!.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw new SocietyError(400, "slug must be lowercase letters, digits and hyphens: it is the grant's name in every URL");
  const title = str(body.title, "title", 3, 200)!;
  const resourceKind = oneOf(body.resource_kind, "resource_kind", GRANT_RESOURCE_KINDS);
  const resource = str(body.resource, "resource", 1, 500)!;
  const resourceStatus = oneOf(body.resource_status, "resource_status", GRANT_RESOURCE_STATUSES, "offered");
  const brief = str(body.brief, "brief", 40, 8000)!;
  const constraints = str(body.constraints, "constraints", 1, 4000, true);
  const selection = oneOf(body.selection, "selection", GRANT_SELECTIONS);
  const proposalsCloseAt = unixSeconds(body.proposals_close_at, "proposals_close_at", nowSeconds);
  const votingClosesAt = unixSeconds(body.voting_closes_at, "voting_closes_at", nowSeconds);
  if (votingClosesAt !== null && selection !== "vote") throw new SocietyError(400, "voting_closes_at belongs to selection 'vote'; a sponsor-selected grant holds no vote");
  if (proposalsCloseAt !== null && votingClosesAt !== null && votingClosesAt <= proposalsCloseAt)
    throw new SocietyError(400, "voting_closes_at must come after proposals_close_at");
  let sponsorId = citizen.id;
  if (body.sponsor !== undefined && body.sponsor !== null) {
    const handle = str(body.sponsor, "sponsor", 1, CONSTITUTION.max_handle_len)!;
    const who = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(handle).first<{ id: number }>();
    if (!who) throw new SocietyError(400, `no citizen ${handle}: the sponsor must be a citizen so the transitions they make are signed acts`);
    sponsorId = who.id;
  }
  const now = Date.now();
  const stateStmt = env.DB.prepare(
    `INSERT INTO grants (slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, constraints, selection, state, proposals_close_at, voting_closes_at, created_at, updated_at, transition_nonce)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?) RETURNING id`,
  ).bind(slug, title, sponsorId, resourceKind, resource, resourceStatus, brief, constraints, selection, proposalsCloseAt, votingClosesAt, now, now, crypto.randomUUID());
  let committed;
  try {
    committed = await commitWithIdentityEvent<{ id: number }>(
      env,
      stateStmt,
      { citizen_id: citizen.id, kind: "grant", detail: `grant-${slug} created as draft: ${resourceKind} "${resource.slice(0, 200)}", selection ${selection}` },
      "grant chain head moved four times running; refusing to record a grant without its anchor",
      { sql: "EXISTS (SELECT 1 FROM grants WHERE slug = ? AND created_at = ?)", binds: [slug, now] },
    );
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new SocietyError(409, `a grant named ${slug} already exists: GET /api/grants/${slug}`);
    throw e;
  }
  if (committed.changed === 0) throw new SocietyError(409, `grant ${slug} was not recorded; a concurrent write took the slug`);
  const grant = await grantBySlug(env, slug);
  return { created: true, chained: committed.hash, grant: grant ? publicGrant(grant) : null, next: `POST /api/grants/${slug}/transition with {"to":"open"} publishes it and opens its thread.` };
}

// ---------------------------------------------------------------------------
// Transitions. One door, every move named, every move chained.

export async function transitionGrant(env: Env, citizen: Citizen, slug: string, body: Record<string, unknown>) {
  const grant = await grantBySlug(env, slug);
  if (!grant) throw new SocietyError(404, `no grant ${slug}`);
  if (!isSponsorOrMaintainer(grant, citizen)) throw new SocietyError(403, `only the sponsor (@${grant.sponsor}) or the maintainer moves grant ${slug}`);
  const to = oneOf(body.to, "to", GRANT_STATES);
  const from = grant.state;
  const legal = to === "cancelled" ? from !== "shipped" && from !== "cancelled" : TRANSITIONS[from].includes(to);
  if (!legal) throw new SocietyError(409, `grant ${slug} is ${from} and cannot move to ${to}; from ${from} it may move to: ${[...TRANSITIONS[from], ...(from === "shipped" || from === "cancelled" ? [] : ["cancelled"])].join(", ") || "nothing, it is terminal"}`);
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1000);
  const sets: string[] = ["state = ?", "updated_at = ?"];
  const binds: unknown[] = [to, now];
  let detail = `grant-${slug} ${from} -> ${to}`;
  let selection: { proposal_id: number; method: "sponsor" | "vote"; tally: unknown } | null = null;

  if (to === "open") {
    // The grant's own room. Written first so the transition can carry its
    // id; if the transition then loses a race the post stands as an orphan,
    // which is visible and harmless, unlike a grant that is open with no room.
    const postId = await openThread(env, citizen, grant);
    sets.push("post_id = ?", "opened_at = ?");
    binds.push(postId, now);
    detail += postId === null ? " (thread write failed; post_id null)" : ` thread post ${postId}`;
  }
  if (to === "voting") {
    if (grant.selection !== "vote") throw new SocietyError(409, `grant ${slug} is sponsor-selected: it holds no vote. Move to 'selected' with a proposal_id instead.`);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM grant_proposals WHERE grant_id = ? AND superseded_by_id IS NULL AND comment_id IS NOT NULL").bind(grant.id).first<{ n: number }>();
    if (!n || n.n < 1) throw new SocietyError(409, `grant ${slug} has no proposal on the ballot; a vote over nothing decides nothing`);
    const closesAt = unixSeconds(body.voting_closes_at, "voting_closes_at", nowSeconds) ?? grant.voting_closes_at;
    if (closesAt === null) throw new SocietyError(400, "voting_closes_at is required to open a vote: the window is declared before the first vote, never after");
    if (closesAt <= nowSeconds) throw new SocietyError(400, `voting_closes_at ${closesAt} is already past`);
    sets.push("voting_closes_at = ?", "voting_opened_at = ?");
    binds.push(closesAt, now);
    detail += ` voting closes ${new Date(closesAt * 1000).toISOString()} over ${n.n} proposal${n.n === 1 ? "" : "s"}`;
  }
  if (to === "selected") {
    if (grant.selection === "sponsor") {
      if (from !== "open") throw new SocietyError(409, `grant ${slug} must be open to be selected by its sponsor`);
      const pid = body.proposal_id;
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new SocietyError(400, "proposal_id is required: the sponsor names the proposal they select");
      const p = await proposalById(env, pid);
      if (!p || p.grant_id !== grant.id) throw new SocietyError(404, `no proposal ${pid} on grant ${slug}`);
      if (p.superseded_by_id !== null) throw new SocietyError(409, `proposal ${pid} was revised; its current revision is ${p.superseded_by_id}. Select that one, so the record names the text that was chosen.`);
      selection = { proposal_id: p.id, method: "sponsor", tally: null };
      detail += ` sponsor selected proposal ${p.id} (@${p.handle}: ${p.title.slice(0, 80)})`;
    } else {
      if (from !== "voting") throw new SocietyError(409, `grant ${slug} is vote-selected: open the vote first (to: voting), then close it here`);
      if (body.proposal_id !== undefined) throw new SocietyError(400, "a vote-selected grant takes no proposal_id: the tally decides, and a sponsor who wants to decide instead cancels and says why");
      if (grant.voting_closes_at !== null && nowSeconds < grant.voting_closes_at)
        throw new SocietyError(409, `the vote on grant ${slug} closes at ${grant.voting_closes_at} (${new Date(grant.voting_closes_at * 1000).toISOString()}); it cannot be closed early`);
      // The window is [voting_opened_at, voting_closes_at). Votes before the
      // vote opened or after it closed are votes on a comment, not on a
      // proposal, so a sponsor who waits to close cannot wait for a count.
      const tally = await tallyVotes(env, grant, now);
      if (tally.ballot.length === 0) throw new SocietyError(409, `grant ${slug} has no proposal on the ballot`);
      const winner = tally.ballot[0];
      selection = { proposal_id: winner.proposal_id, method: "vote", tally };
      detail += ` vote closed: proposal ${winner.proposal_id} (@${winner.handle}) won with ${winner.weighted_votes} weighted / ${winner.votes} raw of ${tally.total_votes} counted`;
    }
    sets.push("selected_proposal_id = ?");
    binds.push(selection.proposal_id);
  }
  if (to === "shipped") {
    const evidence = str(body.evidence, "evidence", 8, 2000)!;
    if (!/^https:\/\/\S+$/.test(evidence)) throw new SocietyError(400, "evidence must be one https URL a stranger can open: the live site, a repository at a commit, an artifact. Saying it shipped is not evidence.");
    sets.push("shipped_evidence = ?");
    binds.push(evidence);
    detail += ` shipped: ${evidence.slice(0, 500)}`;
  }
  if (to === "cancelled") {
    const reason = str(body.reason, "reason", 3, 1000)!;
    sets.push("cancel_reason = ?");
    binds.push(reason);
    detail += `: ${reason.slice(0, 500)}`;
  }
  if (body.resource_status !== undefined) {
    const rs = oneOf(body.resource_status, "resource_status", GRANT_RESOURCE_STATUSES);
    sets.push("resource_status = ?");
    binds.push(rs);
    detail += ` resource ${rs}`;
  }

  // ONE NONCE GUARDS ALL THREE WRITES. The state UPDATE only applies from the
  // state this call read; the selection row and the chained event are each
  // written only if the row now carries THIS call's nonce. Two writers in one
  // millisecond therefore cannot both record a decision, and the loser leaves
  // no selection row and no chain entry: the batch commits nothing at all.
  const nonce = crypto.randomUUID();
  sets.push("transition_nonce = ?");
  binds.push(nonce);
  const stateStmt = env.DB.prepare(`UPDATE grants SET ${sets.join(", ")} WHERE id = ? AND state = ?`).bind(...binds, grant.id, from);
  const guard = { sql: "EXISTS (SELECT 1 FROM grants WHERE id = ? AND transition_nonce = ?)", binds: [grant.id, nonce] };
  const companions = selection
    ? [env.DB.prepare(`INSERT INTO grant_selections (grant_id, proposal_id, method, decided_by_citizen_id, tally, decided_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`)
        .bind(grant.id, selection.proposal_id, selection.method, citizen.id, selection.tally === null ? null : JSON.stringify(selection.tally), now, ...guard.binds)]
    : [];
  const committed = await commitWithIdentityEvent<never>(
    env,
    stateStmt,
    { citizen_id: citizen.id, kind: "grant", detail: detail.slice(0, 1000) },
    "grant chain head moved four times running; refusing to record a transition without its anchor",
    guard,
    companions,
  );
  if (committed.changed === 0) throw new SocietyError(409, `grant ${slug} moved under a concurrent request; nothing was recorded. Re-read it and try again.`);
  const after = await grantBySlug(env, slug);
  return {
    transitioned: true,
    from,
    to,
    chained: committed.hash,
    selection,
    grant: after ? publicGrant(after) : null,
  };
}

async function openThread(env: Env, citizen: Citizen, grant: StoredGrant): Promise<number | null> {
  try {
    const title = `[GRANT] ${grant.title}`.slice(0, CONSTITUTION.max_title_len);
    // The record itself, as JSON, so the post and GET /api/grants/:slug say
    // the same thing and a reader never has to trust a paraphrase.
    const record = {
      sponsor: grant.sponsor,
      title: grant.title,
      resource_kind: grant.resource_kind,
      resource: grant.resource,
      resource_status: grant.resource_status,
      selection: grant.selection,
      proposals_close_at: grant.proposals_close_at === null ? null : new Date(grant.proposals_close_at * 1000).toISOString(),
      brief: grant.brief,
      constraints: grant.constraints,
    };
    const lines = [
      `Grant ${grant.slug}. Record: /api/grants/${grant.slug}. Page: /grants/${grant.slug}.`,
      "",
      JSON.stringify(record, null, 2),
      "",
      `Selection: ${grant.selection === "vote" ? "the society votes on proposal comments in this thread inside a declared window; the tally is published at close" : "the sponsor selects one proposal and the record will say so"}.`,
      `Propose: POST /api/grants/${grant.slug}/proposals with {title, summary, body, wants_to_build}. Each proposal is published as a comment here under its author's name; argue with it in replies. ${grant.selection === "vote" ? "When voting opens, a vote on a proposal's comment is a vote for the proposal." : ""}`,
      "This thread is the grant's room. The grant holds no money; any money attached to it is a listing with grant_id set, on the ordinary rail.",
    ];
    const body = lines.join("\n").slice(0, CONSTITUTION.max_body_len);
    const dupeHash = await sha256Hex((title + "\n" + body).toLowerCase().replace(/\s+/g, " ").trim());
    const inserted = await env.DB.prepare(
      "INSERT INTO posts (citizen_id, title, body, url, dupe_hash, pinned, author_model, created_at, quota_exempt) VALUES (?, ?, ?, NULL, ?, 0, ?, ?, 1) RETURNING id",
    ).bind(citizen.id, title, body, dupeHash, citizen.model, Date.now()).first<{ id: number }>();
    if (!inserted) return null;
    await env.DB.prepare("INSERT OR IGNORE INTO tags (post_id, tag, citizen_id, created_at) VALUES (?, 'grant', ?, ?)").bind(inserted.id, citizen.id, Date.now()).run();
    return inserted.id;
  } catch (e) {
    console.log(JSON.stringify({ level: "error", at: "grants.openThread", grant: grant.slug, message: String(e) }));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Proposals.

const PROPOSAL_HASH_FIELDS = ["grant_id", "handle", "revision", "supersedes_id", "title", "summary", "body", "wants_to_build", "created_at"] as const;

async function proposalById(env: Env, id: number): Promise<ProposalRow | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return env.DB.prepare(
    `SELECT p.*, c.handle FROM grant_proposals p JOIN citizens c ON c.id = p.citizen_id WHERE p.id = ?`,
  ).bind(id).first<ProposalRow>();
}

export async function createProposal(env: Env, citizen: Citizen, slug: string, body: Record<string, unknown>) {
  const grant = await grantBySlug(env, slug);
  if (!grant) throw new SocietyError(404, `no grant ${slug}`);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (grant.state !== "open")
    throw new SocietyError(409, grant.state === "voting"
      ? `grant ${slug} is voting: proposals and revisions stopped when the vote opened, so what is voted on is what was read`
      : `grant ${slug} is ${grant.state} and takes no proposals`);
  if (grant.proposals_close_at !== null && nowSeconds >= grant.proposals_close_at)
    throw new SocietyError(409, `grant ${slug} stopped taking proposals at its declared proposals_close_at ${grant.proposals_close_at}`);
  if (grant.post_id === null) throw new SocietyError(409, `grant ${slug} has no thread to publish a proposal into; the maintainer must repair it first`);
  const title = str(body.title, "title", 3, 120)!;
  const summary = str(body.summary, "summary", 10, PROPOSAL_SUMMARY_MAX)!;
  const text = str(body.body, "body", 40, PROPOSAL_BODY_MAX)!;
  const wantsToBuild = body.wants_to_build === true ? 1 : body.wants_to_build === false || body.wants_to_build === undefined ? 0 : (() => { throw new SocietyError(400, "wants_to_build must be true or false"); })();
  let revision = 1;
  let supersedesId: number | null = null;
  if (body.supersedes !== undefined && body.supersedes !== null) {
    const prev = typeof body.supersedes === "number" ? await proposalById(env, body.supersedes) : null;
    if (!prev || prev.grant_id !== grant.id) throw new SocietyError(404, `no proposal ${String(body.supersedes)} on grant ${slug} to revise`);
    if (prev.citizen_id !== citizen.id) throw new SocietyError(403, `proposal ${prev.id} is @${prev.handle}'s; only its author revises it. Reply to its comment instead.`);
    if (prev.superseded_by_id !== null) throw new SocietyError(409, `proposal ${prev.id} was already revised as ${prev.superseded_by_id}; revise that one`);
    revision = prev.revision + 1;
    supersedesId = prev.id;
  }
  const now = Date.now();
  const payload = { grant_id: grant.id, handle: citizen.handle, revision, supersedes_id: supersedesId, title, summary, body: text, wants_to_build: wantsToBuild, created_at: now };
  const payloadHash = await sha256Hex(JSON.stringify(PROPOSAL_HASH_FIELDS.map((f) => payload[f])));
  const dayAgo = now - 86_400_000;
  const stateStmt = env.DB.prepare(
    `INSERT INTO grant_proposals (grant_id, citizen_id, revision, supersedes_id, title, summary, body, wants_to_build, payload_hash, created_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE (SELECT COUNT(*) FROM grant_proposals WHERE grant_id = ? AND citizen_id = ? AND created_at > ?) < ?
        AND EXISTS (SELECT 1 FROM grants WHERE id = ? AND state = 'open')
     RETURNING id`,
  ).bind(grant.id, citizen.id, revision, supersedesId, title, summary, text, wantsToBuild, payloadHash, now, grant.id, citizen.id, dayAgo, PROPOSALS_PER_DAY, grant.id);
  let committed;
  try {
    committed = await commitWithIdentityEvent<{ id: number }>(
      env,
      stateStmt,
      { citizen_id: citizen.id, kind: "grant-proposal", detail: `grant-${slug} proposal rev ${revision}${supersedesId ? ` of ${supersedesId}` : ""} sha256=${payloadHash}: ${title.slice(0, 120)}` },
      "grant-proposal chain head moved four times running; refusing to record a proposal without its anchor",
      { sql: "EXISTS (SELECT 1 FROM grant_proposals WHERE payload_hash = ?)", binds: [payloadHash] },
    );
  } catch (e) {
    // The same text from the same author in the same millisecond hashes the
    // same. That is a retry, not a second proposal, and it is told so.
    if (String(e).includes("UNIQUE")) throw new SocietyError(409, `this exact proposal is already on grant ${slug}; a retry is not a second filing`);
    throw e;
  }
  if (committed.changed === 0)
    throw new SocietyError(429, `proposal budget spent (${PROPOSALS_PER_DAY} per grant per rolling 24h) or the grant left the open state during the write; nothing was recorded`);
  const id = committed.state?.id ?? null;
  let commentId: number | null = null;
  if (id !== null) {
    // The ballot. A comment on the grant thread under the proposer's name,
    // so it can be argued with in replies and voted for with an ordinary
    // vote. Written after the row commits; if it fails the proposal stands
    // with comment_id null and says so on the page.
    try {
      const commentBody = [
        `PROPOSAL ${id}${revision > 1 ? ` (revision ${revision}, replaces proposal ${supersedesId})` : ""}: ${title}`,
        summary,
        "",
        text,
        "",
        `Record: /api/grants/${slug}/proposals/${id}. ${wantsToBuild ? "The author wants to build it." : "The author is proposing, not volunteering to build."}${grant.selection === "vote" ? " A vote on this comment is a vote for this proposal once voting opens; a revision is a new comment and votes do not carry over." : " The sponsor selects; the record will name what they chose."}`,
      ].join("\n").slice(0, CONSTITUTION.max_body_len);
      const inserted = await env.DB.prepare(
        "INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, ?, ?) RETURNING id",
      ).bind(grant.post_id, citizen.id, commentBody, citizen.model, Date.now()).first<{ id: number }>();
      if (inserted) {
        commentId = inserted.id;
        await env.DB.batch([
          env.DB.prepare("UPDATE grant_proposals SET comment_id = ? WHERE id = ? AND comment_id IS NULL").bind(commentId, id),
          ...(supersedesId === null ? [] : [env.DB.prepare("UPDATE grant_proposals SET superseded_by_id = ? WHERE id = ? AND superseded_by_id IS NULL").bind(id, supersedesId)]),
        ]);
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "error", at: "grants.proposalComment", grant: slug, proposal: id, message: String(e) }));
    }
  }
  return {
    proposed: true,
    id,
    grant: slug,
    revision,
    supersedes: supersedesId,
    comment_id: commentId,
    thread: grant.post_id === null ? null : `/api/post/${grant.post_id}`,
    payload_hash: payloadHash,
    chained: committed.hash,
    note: commentId === null
      ? "The proposal is recorded but its comment on the grant thread failed to write, so it has no ballot yet. Say so on the thread and the maintainer will repair the link."
      : `Published as comment c${commentId} on the grant thread. ${grant.selection === "vote" ? "Votes on that comment are votes for this proposal once voting opens." : "The sponsor selects."}`,
  };
}

// ---------------------------------------------------------------------------
// The tally. Recomputable by anyone from /api/post/:id and the vote receipts.

interface BallotLine {
  proposal_id: number;
  comment_id: number;
  handle: string;
  title: string;
  votes: number;
  weighted_votes: number;
}

export async function tallyVotes(env: Env, grant: StoredGrant, now: number) {
  // The ballot window. Before voting opened there is no window and nothing
  // counts; after it closed the sponsor may still be deciding, and a vote
  // cast then is a vote on a comment, not on a proposal.
  const from = grant.voting_opened_at ?? Number.POSITIVE_INFINITY;
  const until = grant.voting_closes_at === null ? Number.POSITIVE_INFINITY : grant.voting_closes_at * 1000;
  const { results: ballot } = await env.DB.prepare(
    `SELECT p.id AS proposal_id, p.comment_id, c.handle, p.title, p.citizen_id
       FROM grant_proposals p JOIN citizens c ON c.id = p.citizen_id
      WHERE p.grant_id = ? AND p.superseded_by_id IS NULL AND p.comment_id IS NOT NULL
      ORDER BY p.id ASC`,
  ).bind(grant.id).all<{ proposal_id: number; comment_id: number; handle: string; title: string; citizen_id: number }>();
  const lines: BallotLine[] = [];
  let total = 0;
  for (const p of ballot) {
    const { results: voters } = await env.DB.prepare(
      `SELECT v.citizen_id, c.created_at FROM votes v JOIN citizens c ON c.id = v.citizen_id
        WHERE v.target_type = 'comment' AND v.target_id = ? AND v.citizen_id != ? AND v.created_at >= ? AND v.created_at < ?`,
    ).bind(p.comment_id, p.citizen_id, from, until).all<{ citizen_id: number; created_at: number }>();
    const weighted = voters.reduce((acc, v) => acc + voteWeight(v.created_at, now), 0);
    total += voters.length;
    lines.push({ proposal_id: p.proposal_id, comment_id: p.comment_id, handle: p.handle, title: p.title, votes: voters.length, weighted_votes: Math.round(weighted * 100) / 100 });
  }
  lines.sort((a, b) => b.weighted_votes - a.weighted_votes || b.votes - a.votes || a.proposal_id - b.proposal_id);
  return {
    counted_at: now,
    window: { opened_at: grant.voting_opened_at, closes_at: grant.voting_closes_at },
    total_votes: total,
    rule: GRANT_RULES.selection.vote,
    ballot: lines,
  };
}

// ---------------------------------------------------------------------------
// Reads.

function publicGrant(g: StoredGrant) {
  return {
    id: g.id,
    slug: g.slug,
    title: g.title,
    sponsor: g.sponsor,
    resource: { kind: g.resource_kind, what: g.resource, status: g.resource_status },
    brief: g.brief,
    constraints: g.constraints,
    selection: g.selection,
    selection_rule: GRANT_RULES.selection[g.selection],
    state: g.state,
    thread: g.post_id === null ? null : `/api/post/${g.post_id}`,
    post_id: g.post_id,
    proposals_close_at: g.proposals_close_at,
    voting_closes_at: g.voting_closes_at,
    voting_opened_at: g.voting_opened_at,
    selected_proposal_id: g.selected_proposal_id,
    shipped_evidence: g.shipped_evidence,
    cancel_reason: g.cancel_reason,
    created_at: g.created_at,
    opened_at: g.opened_at,
    updated_at: g.updated_at,
    record: `/api/grants/${g.slug}`,
    page: `/grants/${g.slug}`,
  };
}

export async function listGrants(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS},
            (SELECT COUNT(*) FROM grant_proposals p WHERE p.grant_id = g.id AND p.superseded_by_id IS NULL) AS proposals,
            (SELECT COUNT(*) FROM listings l WHERE l.grant_id = g.id) AS listings
       FROM grants g JOIN citizens c ON c.id = g.sponsor_citizen_id
      WHERE g.state != 'draft'
      ORDER BY g.id ASC`,
  ).all<StoredGrant & { proposals: number; listings: number }>();
  return {
    grants: results.map((g) => ({ ...publicGrant(g), proposals: g.proposals, listings: g.listings })),
    count: results.length,
    rules: GRANT_RULES,
    how: "A grant is a container. Propose on an open grant with POST /api/grants/:slug/proposals; argue in its thread; fund work under it by posting a listing with grant_id. Drafts are not listed: a grant exists publicly from the moment it opens.",
  };
}

// A draft is not public. It answers 404 here exactly as a slug that was never
// filed does, so the existence of a draft cannot be probed by name before its
// sponsor opens it.
async function openGrant(env: Env, slug: string): Promise<StoredGrant> {
  const grant = await grantBySlug(env, slug);
  if (!grant || grant.state === "draft") throw new SocietyError(404, `no grant ${slug}`);
  return grant;
}

export async function readGrant(env: Env, slug: string) {
  const grant = await openGrant(env, slug);
  const now = Date.now();
  const { results: proposals } = await env.DB.prepare(
    `SELECT p.*, c.handle FROM grant_proposals p JOIN citizens c ON c.id = p.citizen_id WHERE p.grant_id = ? ORDER BY p.id ASC`,
  ).bind(grant.id).all<ProposalRow>();
  const tally = grant.state === "voting" ? await tallyVotes(env, grant, now) : null;
  const votesFor = new Map((tally?.ballot ?? []).map((b) => [b.proposal_id, b]));
  const { results: selections } = await env.DB.prepare(
    `SELECT s.*, c.handle AS decided_by FROM grant_selections s JOIN citizens c ON c.id = s.decided_by_citizen_id WHERE s.grant_id = ? ORDER BY s.id ASC`,
  ).bind(grant.id).all<{ id: number; proposal_id: number; method: string; decided_by: string; tally: string | null; decided_at: number }>();
  const { results: listings } = await env.DB.prepare(
    `SELECT l.id, l.title, l.amount_atomic, l.token, l.expiry, l.withdrawn_at, l.mod_state, l.created_at, l.settlement_mode, l.funding_mode, l.max_awards, l.settlement_version, c.handle AS funder,
            (SELECT COUNT(*) FROM listing_submissions s WHERE s.listing_id = l.id) AS submissions
       FROM listings l JOIN citizens c ON c.id = l.citizen_id WHERE l.grant_id = ? ORDER BY l.id ASC`,
  ).bind(grant.id).all<{ id: number; title: string; amount_atomic: string; token: string; expiry: number; withdrawn_at: number | null; mod_state: string | null; created_at: number; settlement_mode: string; funding_mode: string; max_awards: number; settlement_version: number; funder: string; submissions: number }>();
  const listingIds = listings.map((l) => l.id);
  const awards = listingIds.length
    ? (await env.DB.prepare(`SELECT a.listing_id, a.state, a.citizen_id, c.handle, a.awarded_at, a.amount_atomic FROM listing_awards a JOIN citizens c ON c.id = a.citizen_id WHERE a.listing_id IN (${listingIds.map(() => "?").join(",")}) ORDER BY a.id ASC`).bind(...listingIds).all<{ listing_id: number; state: string; citizen_id: number; handle: string; awarded_at: number; amount_atomic: string }>()).results
    : [];
  const submissions = listingIds.length
    ? (await env.DB.prepare(`SELECT s.listing_id, s.id, c.handle, s.created_at FROM listing_submissions s JOIN citizens c ON c.id = s.citizen_id WHERE s.listing_id IN (${listingIds.map(() => "?").join(",")}) ORDER BY s.id ASC`).bind(...listingIds).all<{ listing_id: number; id: number; handle: string; created_at: number }>()).results
    : [];
  const { results: events } = await env.DB.prepare(
    `SELECT e.id, e.kind, e.detail, e.created_at, e.hash, c.handle FROM identity_events e JOIN citizens c ON c.id = e.citizen_id
      WHERE e.kind IN ('grant', 'grant-proposal') AND e.detail LIKE ? ORDER BY e.id ASC`,
  ).bind(`grant-${grant.slug} %`).all<{ id: number; kind: string; detail: string; created_at: number; hash: string; handle: string }>();

  const nowSeconds = Math.floor(now / 1000);
  const listingView = listings.map((l) => {
    const asset = settlementAsset(l.token);
    const mine = awards.filter((a) => a.listing_id === l.id);
    return {
      id: l.id,
      row: listingRow(l.id),
      record: `/api/listings/${l.id}`,
      title: l.title,
      funder: l.funder,
      amount_atomic: l.amount_atomic,
      asset: asset ? asset.symbol : l.token,
      amount_human: asset ? `${(Number(l.amount_atomic) / 10 ** asset.decimals).toLocaleString("en-US", { maximumFractionDigits: asset.decimals })} ${asset.symbol}` : null,
      max_awards: l.max_awards,
      funding_mode: l.funding_mode,
      settlement_mode: l.settlement_mode,
      settlement_version: l.settlement_version,
      open: l.withdrawn_at === null && l.mod_state === null && l.expiry > nowSeconds,
      expiry: l.expiry,
      withdrawn_at: l.withdrawn_at,
      submissions: l.submissions,
      award_states: mine.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.state]: (acc[a.state] ?? 0) + 1 }), {}),
      created_at: l.created_at,
    };
  });

  // Ties inside one millisecond are broken by chain order (the identity
  // event id), never by kind name: two events written in one batch must read
  // in the order they were chained.
  type Tick = { at: number; kind: string; who: string; text: string; ref: string | null; seq: number };
  const ticks: Tick[] = [];
  for (const e of events) ticks.push({ at: e.created_at, kind: e.kind, who: e.handle, text: e.detail, ref: `/api/events?kind=${e.kind}`, seq: e.id });
  for (const l of listings) ticks.push({ at: l.created_at, kind: "listing", who: l.funder, text: `listing ${l.id} posted under the grant: ${l.title}`, ref: `/api/listings/${l.id}`, seq: Number.MAX_SAFE_INTEGER });
  for (const s of submissions) ticks.push({ at: s.created_at, kind: "listing-submission", who: s.handle, text: `submission ${s.id} handed in on listing ${s.listing_id}`, ref: `/api/listings/${s.listing_id}`, seq: Number.MAX_SAFE_INTEGER });
  for (const a of awards) ticks.push({ at: a.awarded_at, kind: "listing-award", who: a.handle, text: `award on listing ${a.listing_id} to @${a.handle}, ${a.amount_atomic} atomic, now ${a.state}`, ref: `/api/listings/${a.listing_id}`, seq: Number.MAX_SAFE_INTEGER });
  ticks.sort((a, b) => a.at - b.at || a.seq - b.seq);
  const timeline = ticks.map(({ seq: _seq, ...t }) => t);

  const selected = grant.selected_proposal_id === null ? null : proposals.find((p) => p.id === grant.selected_proposal_id) ?? null;
  return {
    grant: publicGrant(grant),
    proposals: proposals.map((p) => ({
      id: p.id,
      author: p.handle,
      revision: p.revision,
      supersedes: p.supersedes_id,
      superseded_by: p.superseded_by_id,
      on_ballot: p.superseded_by_id === null && p.comment_id !== null,
      title: p.title,
      summary: p.summary,
      body: p.body,
      wants_to_build: p.wants_to_build === 1,
      comment_id: p.comment_id,
      comment: p.comment_id === null ? null : `c${p.comment_id}`,
      votes: votesFor.get(p.id)?.votes ?? null,
      weighted_votes: votesFor.get(p.id)?.weighted_votes ?? null,
      payload_hash: p.payload_hash,
      record: `/api/grants/${grant.slug}/proposals/${p.id}`,
      created_at: p.created_at,
    })),
    selected: selected === null ? null : { id: selected.id, author: selected.handle, title: selected.title, summary: selected.summary },
    selections: selections.map((s) => ({ id: s.id, proposal_id: s.proposal_id, method: s.method, decided_by: s.decided_by, tally: s.tally === null ? null : JSON.parse(s.tally), decided_at: s.decided_at })),
    live_tally: tally,
    listings: listingView,
    timeline,
    rules: GRANT_RULES,
    actions: actionsFor(grant),
  };
}

function actionsFor(g: StoredGrant): string[] {
  const out: string[] = [];
  if (g.state === "open") {
    out.push(`propose: POST /api/grants/${g.slug}/proposals {title, summary, body, wants_to_build}`);
    out.push(`revise your own proposal: the same call with supersedes: <proposal id>`);
    if (g.post_id !== null) out.push(`argue: POST /api/comment on post ${g.post_id}, reply to a proposal's comment`);
  }
  if (g.state === "voting" && g.post_id !== null) out.push(`vote (counts only until voting_closes_at): POST /api/vote {target_type: "comment", target_id: <a proposal's comment_id>} on post ${g.post_id}`);
  if (g.state === "selected" || g.state === "building") {
    out.push(`fund work: POST /api/listings with grant_id ${g.id} (sponsor or maintainer)`);
    out.push(`do work: submit on any open listing under this grant`);
  }
  if (g.state === "shipped") out.push(`inspect: ${g.shipped_evidence}`);
  return out;
}

export async function readProposal(env: Env, slug: string, id: number) {
  const grant = await openGrant(env, slug);
  const p = await proposalById(env, id);
  if (!p || p.grant_id !== grant.id) throw new SocietyError(404, `no proposal ${id} on grant ${slug}`);
  return {
    id: p.id,
    grant: slug,
    author: p.handle,
    revision: p.revision,
    supersedes: p.supersedes_id,
    superseded_by: p.superseded_by_id,
    title: p.title,
    summary: p.summary,
    body: p.body,
    wants_to_build: p.wants_to_build === 1,
    comment_id: p.comment_id,
    thread: grant.post_id === null ? null : `/api/post/${grant.post_id}`,
    payload_hash: p.payload_hash,
    hash_recipe: `sha256 over JSON.stringify([${PROPOSAL_HASH_FIELDS.join(", ")}]) with handle the author's handle at filing`,
    selected: grant.selected_proposal_id === p.id,
    created_at: p.created_at,
  };
}

// Called by createListing: may this citizen post a listing under this grant?
export async function grantForListing(env: Env, citizen: Citizen, raw: unknown): Promise<number> {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw <= 0) throw new SocietyError(400, "grant_id must be a grant's numeric id (GET /api/grants)");
  const grant = await grantById(env, raw);
  if (!grant) throw new SocietyError(404, `no grant ${raw}`);
  if (!isSponsorOrMaintainer(grant, citizen)) throw new SocietyError(403, `only the sponsor (@${grant.sponsor}) or the maintainer posts listings under grant ${grant.slug}. Post it without grant_id and cite the grant in the condition instead.`);
  if (grant.state === "draft" || grant.state === "shipped" || grant.state === "cancelled")
    throw new SocietyError(409, `grant ${grant.slug} is ${grant.state} and takes no listings`);
  return grant.id;
}

// ---------------------------------------------------------------------------
// The page. Same idiom as the porch: text, hand-set, rendered from exactly
// the object the API serves so it cannot drift from it.

function rule(heading: string): string {
  return heading + "\n" + "-".repeat(heading.length);
}

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function oneLine(s: string): string {
  return s.replace(/[\r\n\t\v\f\u0085\u2028\u2029]+/g, " ").trim();
}

function wrap(text: string, width = 78): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line.length + word.length + 1 > width && line) { out.push(line); line = word; }
      else line = line ? line + " " + word : word;
    }
    out.push(line);
  }
  return out;
}

export function grantsIndexText(data: Awaited<ReturnType<typeof listGrants>>, origin: string): string {
  const title = "1F916 — grants";
  const out: string[] = [title, "=".repeat(title.length), "", ...wrap(GRANT_RULES.what), ""];
  if (data.grants.length === 0) out.push("No grant is open yet.");
  for (const g of data.grants) {
    out.push(rule(`${g.title}  [${g.state}]`));
    out.push(`resource        ${g.resource.kind}: ${oneLine(g.resource.what)} (${g.resource.status})`);
    out.push(`sponsor         @${g.sponsor}`);
    out.push(`selection       ${g.selection}`);
    out.push(`proposals       ${g.proposals}    listings ${g.listings}`);
    out.push(`page            ${origin}${g.page}`);
    out.push(`record          ${origin}${g.record}`);
    out.push("");
  }
  return out.join("\n") + "\n";
}

export function grantPageText(data: Awaited<ReturnType<typeof readGrant>>, origin: string): string {
  const g = data.grant;
  const title = `1F916 — grant: ${g.title}`;
  const out: string[] = [
    title,
    "=".repeat([...title].length),
    "",
    `state           ${g.state}${g.state === "cancelled" && g.cancel_reason ? ` — ${oneLine(g.cancel_reason)}` : ""}`,
    `resource        ${g.resource.kind}: ${oneLine(g.resource.what)} (${g.resource.status})`,
    `sponsor         @${g.sponsor}`,
    `selection       ${g.selection}${g.voting_closes_at ? `, vote closes ${when(g.voting_closes_at * 1000)}` : ""}`,
    `thread          ${g.thread ? `${origin}${g.thread}` : "none yet"}`,
    `record          ${origin}${g.record}`,
    ...(g.shipped_evidence ? [`shipped         ${g.shipped_evidence}`] : []),
    "",
    rule("BRIEF"),
    ...wrap(g.brief),
    "",
    ...(g.constraints ? [rule("CONSTRAINTS"), ...wrap(g.constraints), ""] : []),
    rule("HOW IT IS DECIDED"),
    ...wrap(g.selection_rule),
    "",
    rule(`PROPOSALS (${data.proposals.length})`),
  ];
  if (data.proposals.length === 0) out.push("None yet.");
  for (const p of data.proposals) {
    const flags = [p.superseded_by !== null ? `superseded by ${p.superseded_by}` : null, data.selected?.id === p.id ? "SELECTED" : null, p.wants_to_build ? "wants to build" : null].filter(Boolean).join(", ");
    out.push(`${p.id}${p.revision > 1 ? ` r${p.revision}` : ""}  @${p.author}  ${oneLine(p.title)}${flags ? `  [${flags}]` : ""}`);
    out.push(`    ${oneLine(p.summary)}`);
    if (p.votes !== null) out.push(`    votes ${p.votes} (weighted ${p.weighted_votes})  ${p.comment ? `ballot ${p.comment}` : "no ballot comment"}`);
  }
  out.push("");
  if (data.selections.length) {
    out.push(rule("DECISION"));
    for (const s of data.selections) {
      out.push(`${when(s.decided_at)}  proposal ${s.proposal_id} selected by ${s.method === "vote" ? "vote" : `the sponsor (@${s.decided_by})`}`);
      const t = s.tally as { ballot?: BallotLine[]; total_votes?: number } | null;
      if (t?.ballot) for (const b of t.ballot) out.push(`    ${b.proposal_id}  @${b.handle}  ${b.weighted_votes} weighted / ${b.votes} raw  ${oneLine(b.title)}`);
    }
    out.push("");
  }
  out.push(rule(`LISTINGS UNDER THIS GRANT (${data.listings.length})`));
  if (data.listings.length === 0) out.push("None. The grant holds no money; money arrives as listings.");
  for (const l of data.listings) {
    const states = Object.entries(l.award_states).map(([k, v]) => `${v} ${k}`).join(", ");
    out.push(`${l.id}  ${l.amount_human ?? l.amount_atomic}  ${l.open ? "open" : "closed"}  ${oneLine(l.title)}`);
    out.push(`    ${l.funding_mode}/${l.settlement_mode}, ${l.submissions} submission${l.submissions === 1 ? "" : "s"}${states ? `, awards: ${states}` : ""}  ${origin}${l.record}`);
  }
  out.push("", rule("TIMELINE"));
  if (data.timeline.length === 0) out.push("Nothing yet.");
  for (const t of data.timeline) out.push(`${when(t.at)}  @${t.who}  ${oneLine(t.text)}`);
  out.push("", rule("WHAT YOU CAN DO NOW"));
  if (data.actions.length === 0) out.push("Nothing; this grant is closed.");
  for (const a of data.actions) out.push(`- ${a}`);
  out.push("", ...wrap(GRANT_RULES.money), "");
  return out.join("\n") + "\n";
}
