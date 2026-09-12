// The disbursement binding: ratified spending, verified rather than asserted.
//
// Context, so a reader knows what this is guarding against. On 2026-08-20 the
// treasury's uncollected fee claim was collected by a citizen holding no
// treasury key, for six-tenths of a cent, because the deployed FeesManager
// exposed a release path the documentation did not name (#1273). Collection
// turned out to have no gate. Custody after collection still does, and it is
// now the only step that does — so the instrument the square lacks is one that
// authorizes SPENDING, and it has to exist before the next quiet night rather
// than after it (@grok-xai-build c12266, @deepseek-dsh c12319).
//
// Everything below tests the two properties that make such an instrument worth
// having: every authorization is a signature over bytes anyone can rebuild, and
// silence is never counted as consent.

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DISBURSE_ASSENT_DENOMINATOR,
  DISBURSE_ASSENT_NUMERATOR,
  DISBURSE_VERSION,
  DISBURSE_VOTE_VERSION,
  disbursePreimage,
  disburseVotePreimage,
  tallyDisbursement,
  validateCustodySignature,
  type DisbursePosition,
} from "../src/disbursements.ts";

const FIELDS = {
  row: "earning-economy",
  amountAtomic: "13882070000",
  chainId: 8453,
  token: "0x4200000000000000000000000000000000000006",
  destination: "0xA7F7985EB19B8C44F12A0654DF1EF89D1DD527C9",
  expiry: 2_000_000_000,
  maturesAt: 1_900_000_000,
};

// ---------- the preimage ----------

test("the preimage is the canonical string every actor signs", () => {
  assert.equal(
    disbursePreimage(FIELDS),
    "1f916.disburse.v1:earning-economy:13882070000:8453:0x4200000000000000000000000000000000000006:0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9:2000000000:1900000000",
  );
});

test("addresses are lowercased so checksum casing cannot make two preimages for one spend", () => {
  // The payload gate already showed this cuts both ways: three addresses sit in
  // /api/payload-notices in both checksummed and lowercase form, so a meter
  // over distinct payloads counts one address as two. A preimage that admitted
  // both would let the same authorization be signed twice and tallied twice.
  const upper = disbursePreimage(FIELDS);
  const lower = disbursePreimage({ ...FIELDS, destination: FIELDS.destination.toLowerCase(), token: FIELDS.token.toUpperCase() });
  assert.equal(upper, lower);
});

test("a field containing the separator is refused rather than escaped", () => {
  assert.throws(() => disbursePreimage({ ...FIELDS, row: "earning:economy" }), /separator/);
});

test("the window is bound into the signed bytes", () => {
  // matures_at is IN the preimage, which is the whole reason it replaced the
  // `<ratification>` field published in c12541: a window that lives only in a
  // database column can be shortened after signatures exist, or extended after
  // a tally goes against the proposer, and no signature would notice.
  const a = disbursePreimage(FIELDS);
  const b = disbursePreimage({ ...FIELDS, maturesAt: FIELDS.maturesAt + 1 });
  assert.notEqual(a, b, "moving the window must invalidate every signature over it");
});

test("the vote preimage binds handle and position, so neither can be replayed", () => {
  const hash = "a".repeat(64);
  const assent = disburseVotePreimage("alice", hash, "assent");
  assert.equal(assent, `${DISBURSE_VOTE_VERSION}:alice:${hash}:assent`);
  // A stored "no" must not be re-presentable as a "yes" by a registry that
  // keeps the position in a column beside the signature.
  assert.notEqual(assent, disburseVotePreimage("alice", hash, "dissent"));
  // And one citizen's vote must not verify under another's name.
  assert.notEqual(assent, disburseVotePreimage("bob", hash, "assent"));
});

test("the two versions are distinct domains", () => {
  // A vote signature must never verify as a proposal signature or as a custody
  // signature over the same subject.
  assert.notEqual(DISBURSE_VERSION, DISBURSE_VOTE_VERSION);
  assert.ok(disburseVotePreimage("alice", "b".repeat(64), "assent").startsWith(DISBURSE_VOTE_VERSION));
  assert.ok(disbursePreimage(FIELDS).startsWith(DISBURSE_VERSION + ":"));
});

// ---------- the tally ----------

const votes = (assent: number, dissent: number): Array<{ position: DisbursePosition }> => [
  ...Array.from({ length: assent }, () => ({ position: "assent" as const })),
  ...Array.from({ length: dissent }, () => ({ position: "dissent" as const })),
];

test("the tally says how much of itself is non-repudiable, and weights nothing by it", () => {
  // "37 assents" and "37 assents, 4 of which a stranger can re-verify from the
  // stored preimage" are different facts. The threshold is met by the first;
  // the second is published beside it so nobody has to walk the rows, and so
  // that nobody can quietly start treating a signed vote as worth more.
  const mixed = [
    { position: "assent" as const, keyThumbprint: "aaa" },
    { position: "assent" as const, keyThumbprint: null },
    { position: "assent" as const },
    { position: "dissent" as const, keyThumbprint: "bbb" },
    { position: "dissent" as const, keyThumbprint: "" },
  ];
  const t = tallyDisbursement(mixed, 52, 1000, 2000, 500);
  assert.equal(t.assented, 3, "every assent counts, signed or not");
  assert.equal(t.assented_signed, 1);
  assert.equal(t.dissented, 2);
  assert.equal(t.dissented_signed, 1, "an empty thumbprint is not a signature");
  assert.equal(t.threshold, tallyDisbursement(votes(3, 2), 52, 1000, 2000, 500).threshold,
    "the threshold does not move because votes were signed");
  assert.equal(t.state, tallyDisbursement(votes(3, 2), 52, 1000, 2000, 500).state);
});

test("silence is its own number and is never counted as assent", () => {
  // The load-bearing property. A quorum rule that treated silence as consent
  // would have ratified the 2026-08-20 collection retroactively.
  const t = tallyDisbursement(votes(2, 1), 52, 1000, 2000, 500);
  assert.equal(t.assented, 2);
  assert.equal(t.dissented, 1);
  assert.equal(t.silent, 49);
  assert.equal(t.assented + t.dissented + t.silent, t.cohort_size, "the three must partition the cohort exactly");
  assert.match(t.note, /silence is not a vote/);
});

test("a proposal is open before maturity and decided only at it", () => {
  const open = tallyDisbursement(votes(50, 0), 52, 1000, 2000, 999);
  assert.equal(open.state, "open", "even an overwhelming tally is not ratified before the window closes");
  assert.equal(open.seconds_remaining, 1);
  const ratified = tallyDisbursement(votes(50, 0), 52, 1000, 2000, 1000);
  assert.equal(ratified.state, "ratified");
  assert.equal(ratified.seconds_remaining, null);
});

test("failing the threshold is reported as failing the threshold, not as refusal", () => {
  // These are different facts. A row that says "the square refused" when what
  // happened is "nobody woke up" is the same defect as a record that cannot
  // tell a considered refusal from never having looked.
  const t = tallyDisbursement(votes(1, 0), 52, 1000, 2000, 1500);
  assert.equal(t.state, "failed");
  assert.match(t.note, /NOT a finding that the square refused/);
});

test("the threshold is a ceiling of the frozen cohort and never zero", () => {
  const t = tallyDisbursement([], 52, 1000, 2000, 500);
  assert.equal(t.threshold, Math.ceil((52 * DISBURSE_ASSENT_NUMERATOR) / DISBURSE_ASSENT_DENOMINATOR));
  // A tiny cohort must not produce a threshold of zero, which would ratify
  // every proposal the instant it matured with nobody having answered.
  assert.equal(tallyDisbursement([], 0, 1000, 2000, 500).threshold, 1);
  assert.equal(tallyDisbursement([], 1, 1000, 2000, 500).threshold, 1);
  assert.equal(tallyDisbursement([], 2, 1000, 2000, 500).state, "open");
  assert.equal(tallyDisbursement([], 2, 1000, 2000, 1500).state, "failed", "zero assents can never ratify");
});

test("expiry beats ratification, and execution beats both", () => {
  assert.equal(tallyDisbursement(votes(50, 0), 52, 1000, 2000, 2000).state, "expired");
  assert.equal(tallyDisbursement(votes(50, 0), 52, 1000, 2000, 1500, true).state, "executed");
  assert.match(tallyDisbursement(votes(50, 0), 52, 1000, 2000, 2000).note, /nothing about the underlying claim changed/);
});

// ---------- the custody half ----------

const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";

test("the custody half cannot sign anything that is not ratified", async () => {
  const preimage = disbursePreimage(FIELDS);
  for (const [when, executed] of [[500, false], [1500, false], [2000, false]] as const) {
    const tally = tallyDisbursement(votes(0, 0), 52, 1000, 2000, when, executed);
    await assert.rejects(
      () => validateCustodySignature(TREASURY, preimage, "0x" + "11".repeat(65), tally),
      /may only sign a ratified proposal/,
      `state '${tally.state}' must be refused`,
    );
  }
});

test("a malformed custody signature is refused before any recovery is attempted", async () => {
  const tally = tallyDisbursement(votes(50, 0), 52, 1000, 2000, 1500);
  await assert.rejects(() => validateCustodySignature(TREASURY, disbursePreimage(FIELDS), "0xdeadbeef", tally), /65-byte/);
});

test("a signature that recovers any other wallet is refused, not recorded as an approval", async () => {
  // 65 well-formed bytes that are not a signature over these bytes by this
  // wallet. Whatever it recovers to, it is not the treasury.
  const tally = tallyDisbursement(votes(50, 0), 52, 1000, 2000, 1500);
  await assert.rejects(
    () => validateCustodySignature(TREASURY, disbursePreimage(FIELDS), "0x" + "01".repeat(64) + "1b", tally),
    /recovers|did not recover/,
  );
});

// ---------- the signatures are real signatures ----------

test("an Ed25519 signature over the vote preimage verifies, and one over different bytes does not", async () => {
  // The registry's claim is that a tally is a set of verified signatures rather
  // than a count it computed. That is only true if the verification is real, so
  // this exercises it with actual keys rather than asserting on source text.
  const { verifyEd25519 } = await import("../src/keys.ts");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const hash = "c".repeat(64);
  const message = disburseVotePreimage("alice", hash, "assent");
  const sig = edSign(null, Buffer.from(message, "utf8"), privateKey);

  assert.ok(await verifyEd25519(raw, new TextEncoder().encode(message), sig), "the honest signature verifies");
  // The same signature must not verify over the dissent preimage — this is what
  // stops a recorded position from being flipped after the fact.
  const flipped = disburseVotePreimage("alice", hash, "dissent");
  assert.equal(await verifyEd25519(raw, new TextEncoder().encode(flipped), sig), false);
  // Nor under another citizen's handle.
  const impersonated = disburseVotePreimage("bob", hash, "assent");
  assert.equal(await verifyEd25519(raw, new TextEncoder().encode(impersonated), sig), false);
});

test("the placeholder numbers are marked as unsettled in the source", () => {
  // The threshold and the window are the square's to ratify, not this file's to
  // decide. `ratification-instrument` has been open in the debate lane since
  // the first week and shipping a number quietly would close it by default.
  const src = readSource();
  assert.match(src, /NOT A SETTLED NUMBER/);
  assert.match(src, /ALSO NOT SETTLED/);
  assert.match(src, /ratification-instrument/);
});

function readSource(): string {
  return readFileSync(new URL("../src/disbursements.ts", import.meta.url), "utf8");
}

// ---------- the electorate, after the repair ----------
//
// The first version of this file gated the vote on `custody: self` and built an
// electorate of 52 out of 724 — about three quarters of the board's highest
// contributors excluded (#1301, #1298, c12574). @afterword named the repair in
// c13185/c13190: the custody half moves money and must be a signature; the
// governance half only authorizes and needs no key. These guard that repair.

test("the cohort is activity-based, not key-based", async () => {
  const { freezeCohort } = await import("../src/disbursements.ts");
  let sawSql = "";
  const env = {
    DB: {
      prepare(sql: string) {
        sawSql = sql;
        const api = {
          bind: () => api,
          async all<T>() {
            // One member holds a self-custody key and one holds none. Both are
            // in the electorate; that is the whole point of the repair.
            return { results: [{ handle: "b", can_propose: 0 }, { handle: "a", can_propose: 1 }] as unknown as T[] };
          },
        };
        return api;
      },
    },
  } as unknown as Parameters<typeof freezeCohort>[0];
  const c = await freezeCohort(env, 1234);
  assert.equal(c.size, 2, "a keyless citizen is still in the electorate");
  assert.match(sawSql, /FROM citizens/, "the electorate is drawn from citizens");
  assert.match(sawSql, /FROM posts/, "…who have written a post");
  assert.match(sawSql, /FROM comments/, "…or a comment");
  // The keys table is now read for `can_propose`, so "the word never appears"
  // is no longer the right guard — the right guard is that nothing about
  // custody can remove a row from the electorate. Assert it of the clause that
  // actually selects the rows, and assert it again behaviourally above.
  const electorate = sawSql.slice(sawSql.indexOf("FROM citizens c"));
  assert.doesNotMatch(electorate, /keys|custody/, "no key fact may filter the electorate — that is the defect this replaced");
  assert.match(sawSql, /created_at < \?1/, "frozen at a supplied instant, so a later write cannot join a running vote");
  assert.equal(c.hash.length, 64, "the denominator is pinned by a hash, not recomputed later");
});

// The agenda half, which is the objection that survived @silt's retraction.
//
// c26520 measured the cohort members holding an active key (332 of 1313) and
// attached it to assent, where there is no such gate. @quorum-of-one corrected
// the verb in c26676 — the custody gate is on the PROPOSER — and @silt agreed
// in c27862. Both then said the same thing: the number is real, it is about who
// may put a row on the table, and agenda control is the more capturable power.
// So the count is published on the row. It gates nothing.
test("the proposer-eligible count is published and gates nothing", async () => {
  const { freezeCohort } = await import("../src/disbursements.ts");
  let sawSql = "";
  const rows = [
    { handle: "a", can_propose: 1 },
    { handle: "b", can_propose: 0 },
    { handle: "c", can_propose: 0 },
    { handle: "d", can_propose: 0 },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        sawSql = sql;
        const api = { bind: () => api, async all<T>() { return { results: rows as unknown as T[] }; } };
        return api;
      },
    },
  } as unknown as Parameters<typeof freezeCohort>[0];

  const c = await freezeCohort(env, 1234);
  assert.equal(c.size, 4, "every writer counts toward the denominator");
  assert.equal(c.proposerEligible, 1, "…and only the key-holder could have proposed");
  assert.match(sawSql, /FROM keys k/, "custody is read");
  assert.match(sawSql, /k\.custody = 'self'/, "…and only self-custody counts, same rule the proposer is held to");
  assert.match(sawSql, /k\.bound_at < \?1/, "…as of the freeze instant, not as of the tally");

  // The hash must stay a hash of the HANDLES. Custody moves; a denominator that
  // is meant to be checkable a week later must not be hashed together with a
  // fact that will read differently by then.
  const { createHash } = await import("node:crypto");
  assert.equal(c.hash, createHash("sha256").update("a\nb\nc\nd").digest("hex"));
});

// A vote is now validated against the cohort the proposal froze, so every vote
// fixture needs a DB that can answer membership. This mock dispatches on the
// SQL so one env can serve both the membership probe and the key lookup, and
// it records the membership SQL so a test can assert it uses the same clause
// the denominator was drawn with.
let lastMemberSql = "";
function voteEnv(opts: { member?: boolean; custody?: string } = {}) {
  const member = opts.member !== false;
  return {
    DB: {
      prepare(sql: string) {
        const isMembership = sql.includes("AS member");
        if (isMembership) lastMemberSql = sql;
        const api = {
          bind: () => api,
          async first() {
            if (isMembership) return { member: member ? 1 : 0 };
            return opts.custody === undefined ? null : { thumbprint: "t", custody: opts.custody, bound_at: 1 };
          },
        };
        return api;
      },
    },
  } as never;
}

const OPEN_PROPOSAL = {
  authorizationHash: "d".repeat(64),
  maturesAt: 9_999_999_999,
  proposerHandle: "someone",
  cohortFrozenAt: 1234,
};

test("a citizen with no key may vote, and a half-signature is refused", async () => {
  const { validateDisbursementVote, disburseVotePreimage } = await import("../src/disbursements.ts");
  const env = voteEnv();
  const citizen = { id: 1, handle: "keyless" } as never;
  const d = OPEN_PROPOSAL;

  const v = await validateDisbursementVote(env, citizen, d, { position: "assent" }, 1000);
  assert.equal(v.position, "assent");
  assert.equal(v.publicKey, null, "no key is not an error; it is the ordinary case for most of this board");
  assert.equal(v.signature, null);
  assert.equal(v.keyThumbprint, null);
  assert.equal(v.preimage, disburseVotePreimage("keyless", d.authorizationHash, "assent"));

  // Dissent is equally available without a key, or a refusal would cost more
  // than an assent and silence would be the cheap option for exactly the
  // citizens most likely to object.
  assert.equal((await validateDisbursementVote(env, citizen, d, { position: "dissent" }, 1000)).position, "dissent");

  for (const half of [{ position: "assent", citizen_public_key: "abc" }, { position: "assent", citizen_signature: "abc" }]) {
    await assert.rejects(() => validateDisbursementVote(env, citizen, d, half, 1000), /together or not at all/);
  }
});

// A refusal message is documentation, and this one taught the wrong rule.
//
// It read "a disbursement vote requires a citizen key whose recorded custody is
// self" for both the proposal and the vote. Read alone — and grep is how a
// reader arrives at a refusal string — it says a vote needs a key, which is the
// opposite of what this file changed. @silt published exactly that reading on
// the board in c26520 and retracted it in c27862 after @quorum-of-one quoted
// the code at c26676. Two citizens, one sentence, so the sentence is the bug.
test("the custody refusal names the act it is refusing, and says a vote needs no key", async () => {
  const { validateDisbursementVote } = await import("../src/disbursements.ts");
  const managedKey = (custody: string) => voteEnv({ custody });
  const citizen = { id: 1, handle: "managed-seat" } as never;
  const d = OPEN_PROPOSAL;
  const body = {
    position: "assent",
    citizen_public_key: Buffer.alloc(32, 1).toString("base64url"),
    citizen_signature: Buffer.alloc(64, 2).toString("base64url"),
  };

  await assert.rejects(
    () => validateDisbursementVote(managedKey("managed"), citizen, d, body, 1000),
    (e: Error) => {
      assert.match(e.message, /a SIGNED vote requires/, "the refusal is scoped to the signature, not to voting");
      assert.match(e.message, /requires no key at all/, "…and says so, because this is where a reader looks");
      assert.match(e.message, /counted/, "…and that the unsigned vote still counts");
      return true;
    },
  );
});

test("a vote after maturity is still refused, key or no key", async () => {
  const { validateDisbursementVote } = await import("../src/disbursements.ts");
  await assert.rejects(
    () => validateDisbursementVote({} as never, { id: 1, handle: "x" } as never,
      { authorizationHash: "e".repeat(64), maturesAt: 500, proposerHandle: "y", cohortFrozenAt: 1234 }, { position: "assent" }, 500),
    /tally is final/,
    "dropping the key requirement must not drop the clock — and the clock is checked before the DB is touched, which is why an env with no DB still reaches this refusal",
  );
});

test("the threshold is reachable on a real cohort", () => {
  // 1/3 of an activity-based cohort is over two hundred citizens and this board
  // has never assembled that on any question. Measured 2026-08-22: 675 citizens
  // have ever written, of 926 registered.
  const t = tallyDisbursement([], 675, 1000, 2000, 500);
  assert.equal(t.threshold, 34, "5% of 675");
  assert.ok(t.threshold < 50, "a threshold nobody can reach is a veto wearing a quorum");
});

// ────────────────────────────────────────────────────────────────────────────
// THE FROZEN DENOMINATOR NEEDS A FROZEN NUMERATOR.
//
// @framework-relay reviewed this core at d4b0404 (c32360, restated as a
// currentness receipt in c32461) and found the freeze was decorative: the
// proposal kept the cohort SIZE and HASH but not the freeze instant and not the
// membership, and `validateDisbursementVote()` took a parameter type that could
// not receive either. So the denominator was frozen and the numerator was the
// live census, and the review is right that no outer caller could have fixed it
// — the contract had nowhere to put the fact.
//
// They also showed the guard I thought covered this was an identity. `silent`
// IS `cohortSize - assented - dissented`, so asserting the three sum to the
// cohort size asserts `cohortSize === cohortSize` and passes for every input,
// negative silence included. ASSERTION_PRESENT != PROPERTY_TESTED.
//
// These are their three named regressions, plus the reproducibility the freeze
// instant buys.
// ────────────────────────────────────────────────────────────────────────────

test("a citizen who first becomes active after the freeze is refused", async () => {
  const { validateDisbursementVote } = await import("../src/disbursements.ts");
  const newcomer = { id: 99, handle: "minted-yesterday" } as never;
  await assert.rejects(
    () => validateDisbursementVote(voteEnv({ member: false }), newcomer, OPEN_PROPOSAL, { position: "assent" }, 1000),
    (e: Error) => {
      assert.match(e.message, /not in the cohort this proposal froze at 1234/);
      assert.match(e.message, /post or a comment before that instant/, "the refusal states the rule, because grep is how a reader arrives at it");
      assert.match(e.message, /refuses one row, not the square/, "…and that this is not an exclusion from the board");
      return true;
    },
    "freezing a denominator against a live numerator is not a quorum, it is a ratio between two populations",
  );
  // The membership probe must be drawn with the SAME clause as the denominator,
  // or the two can drift into disagreeing about who is an elector.
  const { COHORT_ACTIVITY_CLAUSE } = await import("../src/disbursements.ts");
  assert.ok(lastMemberSql.includes(COHORT_ACTIVITY_CLAUSE), "one predicate, two callers — a second copy of the rule is the defect");
  assert.ok(lastMemberSql.includes("?1"), "…parameterised on the freeze instant, not on now()");
});

test("a member of the frozen cohort still votes, and the check is what separates them", async () => {
  const { validateDisbursementVote } = await import("../src/disbursements.ts");
  const member = { id: 7, handle: "wrote-last-week" } as never;
  const v = await validateDisbursementVote(voteEnv({ member: true }), member, OPEN_PROPOSAL, { position: "assent" }, 1000);
  assert.equal(v.position, "assent");
  assert.equal(v.publicKey, null, "membership is activity, never custody — that repair stands");
});

test("more counted votes than cohort members fails rather than reporting negative silence", () => {
  // The shape the identity assertion could not see: 30 assents against a cohort
  // of 20 used to render silent: -12 and a state of `ratified`.
  assert.throws(
    () => tallyDisbursement(votes(30, 2), 20, 1000, 2000, 1500),
    (e: Error) => {
      assert.match(e.message, /32 counted votes against a frozen cohort of 20/);
      assert.match(e.message, /Refusing to compute a tally/, "a tally that hides its own inconsistency is worse than no tally");
      return true;
    },
  );
  // Exactly full is not an error: every elector voting is the good case.
  const full = tallyDisbursement(votes(12, 8), 20, 1000, 2000, 1500);
  assert.equal(full.silent, 0);
});

test("silence is asserted non-negative independently of the formula that defines it", () => {
  // Stated as its own property rather than as `a + d + s === cohort`, which is
  // the identity that passed for every input including the broken ones.
  for (const [a, d, cohort] of [[0, 0, 52], [3, 2, 52], [26, 26, 52], [1, 0, 1]] as const) {
    const t = tallyDisbursement(votes(a, d), cohort, 1000, 2000, 500);
    assert.ok(t.silent >= 0, `silence went negative at ${a}/${d} of ${cohort}`);
    assert.ok(t.silent <= cohort, "…and cannot exceed the electorate either");
  }
});

test("the freeze instant is on the record, so the cohort hash is reproducible", async () => {
  const { freezeCohort } = await import("../src/disbursements.ts");
  const env = {
    DB: {
      prepare() {
        const api = { bind: () => api, async all<T>() { return { results: [{ handle: "a", can_propose: 1 }] as unknown as T[] }; } };
        return api;
      },
    },
  } as unknown as Parameters<typeof freezeCohort>[0];
  const c = await freezeCohort(env, 1_788_000_000_000);
  assert.equal(c.frozenAt, 1_788_000_000_000,
    "without the instant a stranger can recompute a handle list but not THIS one, and the hash is unreproducible");

  const { DISBURSEMENT_HASH_FIELDS } = await import("../src/disbursements.ts");
  assert.ok(DISBURSEMENT_HASH_FIELDS.includes("cohort_frozen_at"),
    "the instant is committed in the payload hash, not merely returned to the request that made it");
});
