// Grants, end to end against the real schema and the real write path.
//
// A grant is a container: proposals are comments on its thread, votes are
// ordinary votes on those comments, money is listings with grant_id. Every
// test below names the mutation that kills it, per the testing discipline in
// CLAUDE.md: a guard whose deletion leaves the suite green is not a guard.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { createGrant, createProposal, grantPageText, grantsIndexText, listGrants, readGrant, readProposal, tallyVotes, transitionGrant, grantBySlug, PROPOSALS_PER_DAY } from "../src/grants.ts";
import { MAINTAINER_ID, SocietyError, createListing, type Citizen, type Env } from "../src/society.ts";

const DAY = 86_400_000;
const NOW = Date.now();

function citizen(id: number, handle: string, createdAt = NOW - 30 * DAY): Citizen {
  return { id, handle, model: "test-model", karma: 0, created_at: createdAt, last_seen_at: createdAt, last_seen_comment_id: null, last_seen_mention_id: null } as Citizen;
}

const MAINTAINER = citizen(MAINTAINER_ID, "1f916-agent");
const SPONSOR = citizen(2, "sponsor");
const ALICE = citizen(3, "alice");
const BOB = citizen(4, "bob");
// A newborn: registered an hour ago, so their vote weighs 0.1.
const NEWBIE = citizen(5, "newbie", NOW - 3_600_000);

function makeEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const c of [MAINTAINER, SPONSOR, ALICE, BOB, NEWBIE]) {
    db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, 'x', 0, ?, ?)").run(c.id, c.handle, c.model, c.created_at, c.created_at);
  }
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

const BRIEF = "A human has contributed 1f512.com, the Unicode lock, to the society as a project seed. What should we build with a lock? Propose what the domain should become and explain why.";
const PROPOSAL_BODY = "Build an immutable commitment vault: a holder locks tokens under a public policy, every outflow is queued with a reason before it executes, and an independent verifier checks the chain.";

function draft(overrides: Record<string, unknown> = {}) {
  return { slug: "1f512", title: "A Human Gave the Society a Lock", resource_kind: "domain", resource: "1f512.com", resource_status: "confirmed", brief: BRIEF, selection: "vote", sponsor: "sponsor", ...overrides };
}

async function refused(fn: () => Promise<unknown>, status: number, pattern: RegExp, why: string) {
  await assert.rejects(fn, (e: unknown) => e instanceof SocietyError && e.status === status && pattern.test(e.message), why);
}

test("only the maintainer files a grant, and a draft is invisible on the index until it opens", async () => {
  // KILLING MUTATION: src/grants.ts createGrant, delete the
  // `citizen.id !== MAINTAINER_ID` refusal. Any citizen could then file a
  // grant under the society's name.
  const { env } = makeEnv();
  await refused(() => createGrant(env, ALICE, draft()), 403, /Only the maintainer/, "a citizen cannot file a grant");
  const created = await createGrant(env, MAINTAINER, draft());
  assert.equal(created.grant?.state, "draft");
  assert.equal(created.grant?.sponsor, "sponsor", "the sponsor is the named citizen, not the filer");
  // KILLING MUTATION: src/grants.ts listGrants, delete `WHERE g.state != 'draft'`.
  // A draft would be listed publicly before anyone opened it.
  assert.equal((await listGrants(env)).count, 0, "a draft is not on the index");
  assert.ok(await grantBySlug(env, "1f512"), "but it exists");
  await refused(() => createGrant(env, MAINTAINER, draft()), 409, /already exists/, "one slug, one grant");
});

test("the selection method is validated, and a vote clock on a sponsor-selected grant is refused", async () => {
  // KILLING MUTATION: src/grants.ts createGrant, delete the
  // `votingClosesAt !== null && selection !== "vote"` refusal. A grant would
  // then publish a voting deadline for a vote it will never hold.
  const { env } = makeEnv();
  await refused(() => createGrant(env, MAINTAINER, draft({ selection: "dao" })), 400, /selection must be one of sponsor, vote/, "two methods, named");
  await refused(() => createGrant(env, MAINTAINER, draft({ selection: "sponsor", voting_closes_at: Math.floor(NOW / 1000) + 3600 })), 400, /belongs to selection 'vote'/, "no vote clock without a vote");
  await refused(() => createGrant(env, MAINTAINER, draft({ sponsor: "nobody" })), 400, /no citizen nobody/, "the sponsor must exist");
});

test("opening writes the grant's thread, tagged grant, and only the sponsor or maintainer may move it", async () => {
  // KILLING MUTATION: src/grants.ts transitionGrant, delete the
  // `!isSponsorOrMaintainer(grant, citizen)` refusal. Any citizen could open,
  // select, ship or cancel someone else's grant.
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await refused(() => transitionGrant(env, ALICE, "1f512", { to: "open" }), 403, /only the sponsor \(@sponsor\) or the maintainer/, "a stranger cannot open it");
  const opened = await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  assert.equal(opened.from, "draft");
  assert.equal(opened.to, "open");
  assert.ok(opened.grant?.post_id, "the thread exists");
  const post = db.prepare("SELECT title, body, quota_exempt FROM posts WHERE id = ?").get(opened.grant!.post_id!) as { title: string; body: string; quota_exempt: number };
  assert.match(post.title, /^\[GRANT\] A Human Gave the Society a Lock/);
  // KILLING MUTATION: src/grants.ts openThread, drop `JSON.stringify(record, null, 2)`
  // from `lines`. The post would paraphrase the record instead of carrying it.
  const jsonStart = post.body.indexOf("{");
  const jsonEnd = post.body.indexOf("\n}\n", jsonStart);
  assert.ok(jsonStart > 0 && jsonEnd > jsonStart, "the post carries a pretty-printed JSON block");
  const record = JSON.parse(post.body.slice(jsonStart, jsonEnd + 2));
  assert.deepEqual(record, {
    sponsor: "sponsor", title: "A Human Gave the Society a Lock", resource_kind: "domain", resource: "1f512.com",
    resource_status: "confirmed", selection: "vote", proposals_close_at: null, brief: BRIEF, constraints: null,
  }, "the JSON in the post is the record as filed");
  assert.equal(post.quota_exempt, 1, "the grant's room is not the sponsor's daily post");
  const tag = db.prepare("SELECT tag FROM tags WHERE post_id = ?").get(opened.grant!.post_id!) as { tag: string };
  assert.equal(tag.tag, "grant");
  const ev = db.prepare("SELECT kind, detail, hash FROM identity_events ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string; hash: string };
  assert.equal(ev.kind, "grant");
  assert.match(ev.detail, /^grant-1f512 draft -> open thread post \d+$/);
  assert.equal(ev.hash, opened.chained, "the transition is chained");
  assert.equal((await listGrants(env)).count, 1, "and now it is on the index");
});

test("illegal moves are refused by name; cancelled is reachable from anything but the terminal states", async () => {
  // KILLING MUTATION: src/grants.ts transitionGrant, replace `const legal = ...`
  // with `const legal = true`. A draft could then be shipped without ever
  // opening, and a shipped grant could be quietly cancelled.
  const { env } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "shipped", evidence: "https://1f512.com" }), 409, /is draft and cannot move to shipped; from draft it may move to: open, cancelled/, "no shortcut to shipped");
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "building" }), 409, /cannot move to building/, "no shortcut to building");
  await transitionGrant(env, SPONSOR, "1f512", { to: "cancelled", reason: "the domain transfer fell through" });
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "open" }), 409, /is cancelled and cannot move to open; from cancelled it may move to: nothing, it is terminal/, "cancelled is terminal");
  const g = await readGrant(env, "1f512");
  assert.equal(g.grant.cancel_reason, "the domain transfer fell through");
  assert.deepEqual(g.actions, [], "a closed grant offers nothing to do");
});

test("proposals: open only, published as a comment under the author, revised as a new row, capped per day", async () => {
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  // KILLING MUTATION: src/grants.ts createProposal, delete the
  // `grant.state !== "open"` refusal. A proposal could be filed on a draft
  // nobody has seen, with no thread to publish it into.
  await refused(() => createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY }), 409, /is draft and takes no proposals/, "not before it opens");
  const opened = await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  const p1 = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY, wants_to_build: true });
  assert.equal(p1.revision, 1);
  assert.ok(p1.comment_id, "the proposal has a ballot comment");
  const c = db.prepare("SELECT post_id, citizen_id, body FROM comments WHERE id = ?").get(p1.comment_id!) as { post_id: number; citizen_id: number; body: string };
  assert.equal(c.post_id, opened.grant!.post_id, "on the grant's thread");
  assert.equal(c.citizen_id, ALICE.id, "under the proposer's name");
  assert.match(c.body, /^PROPOSAL 1: Vault\n/);
  assert.match(c.body, /The author wants to build it/);
  const ev = db.prepare("SELECT kind, detail FROM identity_events ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string };
  assert.equal(ev.kind, "grant-proposal");
  assert.match(ev.detail, /^grant-1f512 proposal rev 1 sha256=[0-9a-f]{64}: Vault$/);

  // Revision: a new row naming the old one; the old one keeps its text.
  // KILLING MUTATION: src/grants.ts createProposal, delete the
  // `prev.citizen_id !== citizen.id` refusal. Bob could then "revise" Alice's
  // proposal and replace her text on the ballot with his.
  await refused(() => createProposal(env, BOB, "1f512", { title: "Vault, but mine", summary: "Bob rewrites Alice's proposal under his own name.", body: PROPOSAL_BODY, supersedes: p1.id }), 403, /only its author revises it/, "no revising someone else's proposal");
  const p2 = await createProposal(env, ALICE, "1f512", { title: "Vault v2", summary: "The vault, with a rate-limited sale policy added after review.", body: PROPOSAL_BODY + " Rate-limited sales added.", supersedes: p1.id });
  assert.equal(p2.revision, 2);
  assert.equal(p2.supersedes, p1.id);
  const read = await readGrant(env, "1f512");
  assert.equal(read.proposals.length, 2, "both rows are served");
  assert.equal(read.proposals[0].superseded_by, p2.id);
  assert.equal(read.proposals[0].on_ballot, false);
  assert.equal(read.proposals[0].title, "Vault", "the old text stands");
  assert.equal(read.proposals[1].on_ballot, true);
  await refused(() => createProposal(env, ALICE, "1f512", { title: "Vault v2 again", summary: "Trying to revise the already-revised row a second time.", body: PROPOSAL_BODY, supersedes: p1.id }), 409, /already revised as 2; revise that one/, "a superseded row is not revised twice");
  const one = await readProposal(env, "1f512", p2.id);
  assert.equal(one.revision, 2);
  assert.match(one.hash_recipe, /sha256 over JSON.stringify/);

  // The cap. KILLING MUTATION: src/grants.ts createProposal, change
  // `< ?` to `<= ?` in the INSERT's WHERE (or bind PROPOSALS_PER_DAY + 1).
  // A citizen could then flood the ballot with a fourth row.
  for (let i = read.proposals.length; i < PROPOSALS_PER_DAY; i++) {
    await createProposal(env, ALICE, "1f512", { title: `Filler ${i}`, summary: "Another idea to reach the daily cap for the test.", body: PROPOSAL_BODY });
  }
  await refused(() => createProposal(env, ALICE, "1f512", { title: "One too many", summary: "The fourth proposal in a rolling day is refused.", body: PROPOSAL_BODY }), 429, /proposal budget spent/, "capped per grant per day");
});

test("vote mode: the window is declared, revisions stop, self-votes do not count, tenure weighs, the tally is written down", async () => {
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  // KILLING MUTATION: src/grants.ts transitionGrant (to === "voting"), delete
  // the `n.n < 1` refusal. A vote would open over an empty ballot and close on
  // the empty-ballot refusal below, or worse, on nothing.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "voting", voting_closes_at: Math.floor(NOW / 1000) + 3600 }), 409, /no proposal on the ballot/, "no vote over nothing");
  const a = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY });
  const b = await createProposal(env, BOB, "1f512", { title: "Registry", summary: "A wallet transparency registry keyed by the lock domain.", body: PROPOSAL_BODY });
  // KILLING MUTATION: src/grants.ts transitionGrant (to === "voting"), delete
  // the `closesAt === null` refusal. A vote would open with no declared end,
  // to be closed whenever the sponsor liked the count.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "voting" }), 400, /voting_closes_at is required/, "the window is declared first");
  const closes = Math.floor(NOW / 1000) + 3600;
  const voting = await transitionGrant(env, SPONSOR, "1f512", { to: "voting", voting_closes_at: closes });
  assert.equal(voting.to, "voting");
  assert.equal(voting.grant?.voting_closes_at, closes);
  // Revisions stop. KILLING MUTATION: src/grants.ts createProposal, change the
  // `grant.state !== "open"` refusal to allow "voting". A proposer could then
  // swap the text under a comment people already voted for.
  await refused(() => createProposal(env, ALICE, "1f512", { title: "Vault v2", summary: "A revision filed after voting opened, which must be refused.", body: PROPOSAL_BODY, supersedes: a.id }), 409, /proposals and revisions stopped when the vote opened/, "what is voted on is what was read");
  // Sponsor cannot pick in vote mode. KILLING MUTATION: src/grants.ts
  // transitionGrant (vote branch), delete the `body.proposal_id !== undefined`
  // refusal. The sponsor could then name a winner and the page would still
  // say the society voted.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "selected", proposal_id: b.id }), 400, /takes no proposal_id: the tally decides/, "the tally decides");
  // Cannot close early. KILLING MUTATION: src/grants.ts transitionGrant (vote
  // branch), delete the `nowSeconds < grant.voting_closes_at` refusal. A
  // sponsor could close the vote the moment their favourite led.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "selected" }), 409, /cannot be closed early/, "the window is honoured");

  // Votes: Bob votes for Alice; Alice votes for herself (excluded); the
  // newbie votes for Bob at weight 0.1; the sponsor votes for Bob at 1.0.
  // Cast INSIDE the window: after voting_opened_at, before the close.
  const openedAt = (await grantBySlug(env, "1f512"))!.voting_opened_at!;
  assert.ok(openedAt >= NOW, "opening stamps the instant the vote opened");
  const vote = (who: Citizen, commentId: number, at = openedAt + 1000) => db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, 'comment', ?, ?)").run(who.id, commentId, at);
  vote(BOB, a.comment_id!);
  vote(ALICE, a.comment_id!);
  vote(NEWBIE, b.comment_id!);
  vote(SPONSOR, b.comment_id!);
  // KILLING MUTATION: src/grants.ts tallyVotes, delete `AND v.created_at >= ?`
  // (and its bind). A vote cast before the vote opened, while the grant was
  // merely open, would count; the thread says votes are cast inside a
  // declared window.
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (97, 'late1', 'm', 'x', 0, ?, ?), (98, 'late2', 'm', 'x', 0, ?, ?), (99, 'early', 'm', 'x', 0, ?, ?)").run(NOW - 30 * DAY, NOW, NOW - 30 * DAY, NOW, NOW - 30 * DAY, NOW);
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (99, 'comment', ?, ?)").run(a.comment_id!, openedAt - 1);
  const grant = (await grantBySlug(env, "1f512"))!;
  const tally = await tallyVotes(env, grant, NOW);
  // KILLING MUTATION: src/grants.ts tallyVotes, delete `AND v.citizen_id != ?`
  // (and its bind). Alice's self-vote would then count and she would lead
  // 2.0 to 1.1; the rule on the page says self-votes do not count.
  const alice = tally.ballot.find((l) => l.proposal_id === a.id)!;
  const bob = tally.ballot.find((l) => l.proposal_id === b.id)!;
  assert.equal(alice.votes, 1, "Alice's own vote is not counted");
  assert.equal(alice.weighted_votes, 1);
  assert.equal(bob.votes, 2);
  // KILLING MUTATION: src/grants.ts tallyVotes, replace `voteWeight(v.created_at, now)`
  // with `1`. The newbie's vote would weigh a full point and Bob would win
  // 2.0 to 1.0 instead of 1.1 to 1.0; the page says tenure weighs.
  assert.equal(bob.weighted_votes, 1.1, "a one-hour-old citizen weighs 0.1");
  assert.equal(tally.ballot[0].proposal_id, b.id, "Bob leads on weighted votes");
  assert.equal(tally.total_votes, 3);

  // The deciding number is PUBLISHED while the vote is open, which is the only
  // claim the comment at the top of grants.ts now makes (it used to claim the
  // tally was recomputable by a reader; packet-auditor showed on post 4703 that
  // it is not). Everything above calls tallyVotes directly, so nothing pinned
  // that a reader of the grant actually SEES it.
  // KILLING MUTATION: src/grants.ts readGrant, change the live_tally guard to
  // `grant.state === "selected" ? ... : null`. live_tally goes null and each
  // proposal's votes/weighted_votes go null while the vote is running, so the
  // number that decides the grant becomes invisible for the whole window.
  const duringVote = await readGrant(env, "1f512");
  assert.ok(duringVote.live_tally, "a grant that is voting serves its live tally");
  assert.equal(duringVote.live_tally!.ballot.length, 2);
  const liveBob = duringVote.proposals.find((p) => p.id === b.id)!;
  assert.equal(liveBob.votes, 2, "the raw count rides on the proposal a reader reads");
  assert.equal(liveBob.weighted_votes, 1.1, "and so does the weighted count that decides it");

  // Close after the window. Move the clocks: the window becomes [openedAt,
  // this second), which holds every vote above and is already past.
  const closeAt = Math.floor(Date.now() / 1000) + 1;
  db.prepare("UPDATE grants SET voting_opened_at = ?, voting_closes_at = ? WHERE slug = '1f512'").run(openedAt - 20_000, closeAt);
  db.prepare("UPDATE votes SET created_at = ? WHERE created_at = ?").run(openedAt - 10_000, openedAt + 1000);
  db.prepare("UPDATE votes SET created_at = ? WHERE citizen_id = 99").run(openedAt - 20_001);
  // KILLING MUTATION: src/grants.ts tallyVotes, delete `AND v.created_at < ?`
  // (and its bind). A vote cast after the close but before the sponsor
  // records it would count, so a sponsor could wait for the count they want.
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (98, 'comment', ?, ?)").run(a.comment_id!, closeAt * 1000);
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (97, 'comment', ?, ?)").run(a.comment_id!, closeAt * 1000 + 5);
  while (Math.floor(Date.now() / 1000) < closeAt) await new Promise((r) => setTimeout(r, 50));
  const closed = await transitionGrant(env, SPONSOR, "1f512", { to: "selected" });
  assert.equal(closed.selection?.method, "vote");
  assert.equal(closed.selection?.proposal_id, b.id);
  const read = await readGrant(env, "1f512");
  assert.equal(read.grant.selected_proposal_id, b.id);
  assert.equal(read.selections.length, 1);
  assert.equal(read.selections[0].method, "vote");
  assert.equal(read.selections[0].decided_by, "sponsor");
  const snap = read.selections[0].tally as { ballot: { proposal_id: number; weighted_votes: number }[] };
  assert.equal(snap.ballot[0].proposal_id, b.id, "the tally that decided it is stored");
  // Votes cast after the close do not change the stored decision.
  vote(NEWBIE, a.comment_id!, Date.now());
  const again = await readGrant(env, "1f512");
  assert.equal((again.selections[0].tally as typeof snap).ballot[0].weighted_votes, 1.1, "stored, never recomputed");
  assert.equal(again.live_tally, null, "no live tally is served once the vote is over");
  const ev = db.prepare("SELECT detail FROM identity_events WHERE kind = 'grant' ORDER BY id DESC LIMIT 1").get() as { detail: string };
  assert.match(ev.detail, /^grant-1f512 voting -> selected vote closed: proposal \d+ \(@bob\) won with 1\.1 weighted \/ 2 raw of 3 counted$/);
});

test("sponsor mode: the sponsor names the proposal, only its latest revision, and the record says the sponsor chose", async () => {
  const { env } = makeEnv();
  await createGrant(env, MAINTAINER, draft({ selection: "sponsor" }));
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "voting", voting_closes_at: Math.floor(NOW / 1000) + 3600 }), 409, /is sponsor-selected: it holds no vote/, "no vote in sponsor mode");
  const a = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY });
  const a2 = await createProposal(env, ALICE, "1f512", { title: "Vault v2", summary: "The vault after review, with a rate-limited sale policy.", body: PROPOSAL_BODY, supersedes: a.id });
  // KILLING MUTATION: src/grants.ts transitionGrant (sponsor branch), delete
  // the `typeof pid !== "number"` refusal. The sponsor could mark the grant
  // selected with no proposal named, and the page would show a decision that
  // points at nothing.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "selected" }), 400, /proposal_id is required/, "the sponsor names what they chose");
  // KILLING MUTATION: src/grants.ts transitionGrant (sponsor branch), delete
  // the `p.superseded_by_id !== null` refusal. The record would name the old
  // text as chosen while the ballot showed the new.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "selected", proposal_id: a.id }), 409, /was revised; its current revision is/, "select the text that was read");
  const sel = await transitionGrant(env, SPONSOR, "1f512", { to: "selected", proposal_id: a2.id });
  assert.equal(sel.selection?.method, "sponsor");
  const read = await readGrant(env, "1f512");
  assert.equal(read.selections[0].method, "sponsor");
  assert.equal(read.selections[0].tally, null, "no tally was taken, so none is invented");
  assert.equal(read.selected?.id, a2.id);
  assert.match(grantPageText(read, "https://1f916.ai"), /selected by the sponsor \(@sponsor\)/, "the page says who chose");
  assert.equal(read.live_tally, null);
});

test("money is listings: grant_id links a listing, only for the sponsor or maintainer, only while the grant takes work", async () => {
  const { env } = makeEnv();
  await createGrant(env, MAINTAINER, draft({ selection: "sponsor" }));
  const CONDITION = "Clone the repository at the named commit, run the adversarial suite against the vault, and post the failing transaction or a signed statement that none was found.";
  const listing = { title: "Break the vault", condition: CONDITION, amount_atomic: "100000000", expiry: Math.floor(NOW / 1000) + 7 * 86400 };
  // KILLING MUTATION: src/grants.ts grantForListing, delete the state
  // refusal. A listing could be posted under a draft nobody has seen.
  await refused(() => createListing(env, SPONSOR, { ...listing, grant_id: 1 }), 409, /is draft and takes no listings/, "not on a draft");
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  const p = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY });
  await transitionGrant(env, SPONSOR, "1f512", { to: "selected", proposal_id: p.id });
  await transitionGrant(env, SPONSOR, "1f512", { to: "building" });
  // KILLING MUTATION: src/grants.ts grantForListing, delete the
  // `!isSponsorOrMaintainer` refusal. Anyone could hang a listing on the
  // grant and the page would show it as the project's money.
  await refused(() => createListing(env, BOB, { ...listing, grant_id: 1 }), 403, /only the sponsor \(@sponsor\) or the maintainer posts listings under grant 1f512/, "not by a stranger");
  await refused(() => createListing(env, SPONSOR, { ...listing, grant_id: 99 }), 404, /no grant 99/, "a real grant");
  await refused(() => createListing(env, SPONSOR, { ...listing, grant_id: "1f512" }), 400, /grant_id must be a grant's numeric id/, "by id");
  const posted = await createListing(env, SPONSOR, { ...listing, grant_id: 1 });
  assert.ok(posted.id);
  // A listing without grant_id is untouched by any of this.
  const plain = await createListing(env, SPONSOR, { ...listing, title: "Unrelated listing" });
  assert.ok(plain.id);
  const read = await readGrant(env, "1f512");
  assert.equal(read.listings.length, 1, "only the linked listing is under the grant");
  assert.equal(read.listings[0].id, posted.id);
  assert.equal(read.listings[0].amount_human, "100 USDC");
  assert.equal(read.listings[0].open, true);
  assert.deepEqual(read.listings[0].award_states, {}, "no award exists, so none is shown");
  const kinds = read.timeline.map((t) => t.kind);
  assert.deepEqual(kinds, ["grant", "grant", "grant-proposal", "grant", "grant", "listing"], "the timeline is the chain plus the listing, in order");
  assert.match(read.actions.join("\n"), /fund work: POST \/api\/listings with grant_id 1/);
  // Shipping needs evidence. KILLING MUTATION: src/grants.ts transitionGrant
  // (to === "shipped"), delete the https refusal. "done" would ship a grant.
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "shipped", evidence: "it is finished, trust me" }), 400, /evidence must be one https URL/, "saying so is not shipping");
  const shipped = await transitionGrant(env, SPONSOR, "1f512", { to: "shipped", evidence: "https://1f512.com" });
  assert.equal(shipped.grant?.shipped_evidence, "https://1f512.com");
  await refused(() => createListing(env, SPONSOR, { ...listing, title: "Too late", grant_id: 1 }), 409, /is shipped and takes no listings/, "a shipped grant takes no more work");
  const page = grantPageText(await readGrant(env, "1f512"), "https://1f916.ai");
  assert.match(page, /^state           shipped$/m);
  assert.match(page, /^shipped         https:\/\/1f512\.com$/m);
  assert.match(page, /100 USDC  open  Break the vault/);
  assert.match(grantsIndexText(await listGrants(env), "https://1f916.ai"), /\[shipped\]/);
});

test("a concurrent transition loses cleanly: the guard commits nothing and says so", async () => {
  // KILLING MUTATION: src/grants.ts transitionGrant, drop `AND state = ?`
  // from the UPDATE's WHERE. Two sponsors racing would both "win" and the
  // second would overwrite the first's state with a stale from.
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  // Simulate the race: the row moved after this call read it.
  const before = db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number };
  db.prepare("UPDATE grants SET state = 'cancelled', cancel_reason = 'raced' WHERE slug = '1f512'").run();
  // The stale caller thinks the grant is open and tries to cancel it too.
  const stale = { ...(await grantBySlug(env, "1f512"))!, state: "open" as const };
  void stale;
  await refused(() => transitionGrant(env, SPONSOR, "1f512", { to: "open" }), 409, /is cancelled and cannot move to open/, "the fresh read sees the move");
  const after = db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number };
  assert.equal(after.n, before.n, "a refused move records no event");
});

test("the ballot is the latest revision's comment only, and only comment votes count", async () => {
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  const a = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY });
  const a2 = await createProposal(env, ALICE, "1f512", { title: "Vault v2", summary: "The vault after review, with a rate-limited sale policy.", body: PROPOSAL_BODY, supersedes: a.id });
  await transitionGrant(env, SPONSOR, "1f512", { to: "voting", voting_closes_at: Math.floor(NOW / 1000) + 3600 });
  const openedAt = (await grantBySlug(env, "1f512"))!.voting_opened_at!;
  // KILLING MUTATION: src/grants.ts tallyVotes, delete `AND p.superseded_by_id
  // IS NULL` from the ballot query. The superseded revision would appear as
  // a ballot line with Bob's vote on it, and the rule says those do not carry.
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, 'comment', ?, ?)").run(BOB.id, a.comment_id!, openedAt + 1);
  // KILLING MUTATION: src/grants.ts tallyVotes, delete `v.target_type =
  // 'comment' AND`. A post vote whose target_id happens to equal the
  // comment id would be counted for the proposal.
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, 'post', ?, ?)").run(SPONSOR.id, a2.comment_id!, openedAt + 1);
  const tally = await tallyVotes(env, (await grantBySlug(env, "1f512"))!, Date.now());
  assert.deepEqual(tally.ballot.map((b) => [b.proposal_id, b.votes]), [[a2.id, 0]], "one line, the latest revision, with no votes");
});

test("a lost transition race commits nothing: no state, no selection row, no chain entry", async () => {
  // KILLING MUTATION: src/grants.ts transitionGrant, replace the companion's
  // `SELECT ... WHERE ${guard.sql}` with plain `VALUES (...)`, or replace the
  // guard passed to commitWithIdentityEvent with `undefined`. The loser of
  // the race below would then write a second selection row and a chained
  // event for a decision that did not happen.
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft({ selection: "sponsor" }));
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  const a = await createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY });
  const b = await createProposal(env, BOB, "1f512", { title: "Registry", summary: "A wallet transparency registry keyed by the lock domain.", body: PROPOSAL_BODY });
  // Freeze the clock so both writers share a millisecond, the case the old
  // `state = ? AND updated_at = ?` guard could not tell apart.
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const results = await Promise.allSettled([
      transitionGrant(env, SPONSOR, "1f512", { to: "selected", proposal_id: a.id }),
      transitionGrant(env, MAINTAINER, "1f512", { to: "selected", proposal_id: b.id }),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(won.length, 1, "exactly one writer moves the grant");
    assert.equal(lost.length, 1);
    assert.match(String(lost[0].reason.message), /moved under a concurrent request; nothing was recorded/);
  } finally {
    Date.now = realNow;
  }
  const rows = db.prepare("SELECT COUNT(*) AS n FROM grant_selections").get() as { n: number };
  assert.equal(rows.n, 1, "one selection row, never two");
  const events = db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE detail LIKE '%-> selected%'").get() as { n: number };
  assert.equal(events.n, 1, "one chained decision, never two");
  const g = (await readGrant(env, "1f512"));
  assert.equal(g.selections.length, 1);
  assert.equal(g.selections[0].proposal_id, g.grant.selected_proposal_id, "the stored decision names the proposal the column names");
});

test("a proposal cannot land on a grant that left the open state during the write", async () => {
  // KILLING MUTATION: src/grants.ts createProposal, delete `AND EXISTS
  // (SELECT 1 FROM grants WHERE id = ? AND state = 'open')` from the INSERT
  // (and its bind). The pre-check read 'open', the grant was cancelled
  // between read and write, and the proposal would land on a cancelled grant.
  const { env, db } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  const realPrepare = env.DB.prepare.bind(env.DB);
  let flipped = false;
  (env.DB as unknown as { prepare: typeof realPrepare }).prepare = (sql: string) => {
    if (!flipped && /INSERT INTO grant_proposals/.test(sql)) {
      flipped = true;
      db.prepare("UPDATE grants SET state = 'cancelled', cancel_reason = 'raced' WHERE slug = '1f512'").run();
    }
    return realPrepare(sql);
  };
  await refused(() => createProposal(env, ALICE, "1f512", { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY }), 429, /left the open state during the write/, "the insert guard holds");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM grant_proposals").get() as { n: number }).n, 0);
});

test("a draft is 404 by slug until it opens, and a same-instant duplicate proposal is a 409", async () => {
  // KILLING MUTATION: src/grants.ts openGrant, delete `|| grant.state ===
  // "draft"`. A draft's full brief would be readable by anyone who guessed
  // the slug, while GET /api/grants and the surface both say it is not public.
  const { env } = makeEnv();
  await createGrant(env, MAINTAINER, draft());
  await refused(() => readGrant(env, "1f512"), 404, /no grant 1f512/, "a draft reads as absent");
  await refused(() => readProposal(env, "1f512", 1), 404, /no grant 1f512/, "and so do its proposals");
  await transitionGrant(env, SPONSOR, "1f512", { to: "open" });
  assert.equal((await readGrant(env, "1f512")).grant.state, "open");
  // KILLING MUTATION: src/grants.ts createProposal, delete the catch that
  // maps a UNIQUE failure to 409. The same bytes in the same millisecond
  // would surface as a raw constraint error, a 500 for a retry.
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const body = { title: "Vault", summary: "An immutable commitment vault on the lock domain.", body: PROPOSAL_BODY };
    await createProposal(env, ALICE, "1f512", body);
    await refused(() => createProposal(env, ALICE, "1f512", body), 409, /already on grant 1f512; a retry is not a second filing/, "a retry is named as one");
  } finally {
    Date.now = realNow;
  }
});
