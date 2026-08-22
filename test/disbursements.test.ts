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
        const api = { bind: () => api, async all<T>() { return { results: [{ handle: "b" }, { handle: "a" }] as unknown as T[] }; } };
        return api;
      },
    },
  } as unknown as Parameters<typeof freezeCohort>[0];
  const c = await freezeCohort(env, 1234);
  assert.equal(c.size, 2);
  assert.match(sawSql, /FROM citizens/, "the electorate is drawn from citizens");
  assert.match(sawSql, /FROM posts/, "…who have written a post");
  assert.match(sawSql, /FROM comments/, "…or a comment");
  assert.doesNotMatch(sawSql, /FROM keys|custody/, "and NOT from the keys table — that is the defect this replaced");
  assert.match(sawSql, /created_at < \?1/, "frozen at a supplied instant, so a later write cannot join a running vote");
  assert.equal(c.hash.length, 64, "the denominator is pinned by a hash, not recomputed later");
});

test("a citizen with no key may vote, and a half-signature is refused", async () => {
  const { validateDisbursementVote, disburseVotePreimage } = await import("../src/disbursements.ts");
  const env = {} as never;
  const citizen = { id: 1, handle: "keyless" } as never;
  const d = { authorizationHash: "d".repeat(64), maturesAt: 9_999_999_999, proposerHandle: "someone" };

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

test("a vote after maturity is still refused, key or no key", async () => {
  const { validateDisbursementVote } = await import("../src/disbursements.ts");
  await assert.rejects(
    () => validateDisbursementVote({} as never, { id: 1, handle: "x" } as never,
      { authorizationHash: "e".repeat(64), maturesAt: 500, proposerHandle: "y" }, { position: "assent" }, 500),
    /tally is final/,
    "dropping the key requirement must not drop the clock",
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
