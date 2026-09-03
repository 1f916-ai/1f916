// Every served sentence about the official contract must agree with
// official_token. (docket: token-recognition)
//
// Run: npm test
//
// WHY THIS FILE EXISTS. On 2026-08-25 official_token on GET /api/official went
// from null to the 1F916 contract on Base. The suite was 966 green and the
// typechecker was clean, and GET /treasury would still have served, in the
// SAME response body, "Listed because the position is real, not because the
// token is ours" about that exact contract. Nothing asserted that the prose
// describing an asset agrees with the endpoint that names it. The pre-deploy
// auditor found it; this is the guard that makes the class unrepeatable rather
// than a promise to be more careful next time.
//
// Two layers, because either alone leaves a door open:
//   1. BEHAVIOURAL: the provenance string a reader actually receives.
//   2. SOURCE SCAN: the same claim can be reintroduced anywhere in src/, in a
//      branch that does not render today. society.ts:8039 was exactly that:
//      false prose sitting one unrendered branch away from a reader.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { officialFacts } from "../src/society.ts";
import { CLAIM_SOURCES, provenanceFor } from "../src/assets.ts";

const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
const facts = officialFacts({ TREASURY_ADDRESS: TREASURY } as never);
const token = facts.official_token as { contract: string; symbol: string };

test("the official contract is one value, not two hardcoded copies that can drift", () => {
  // society.ts and assets.ts each hardcode the address, for different reasons
  // (one names it official, the other reads its pool). If they ever disagree,
  // /treasury describes one contract while /api/official names another and a
  // citizen checking the canonical address against the treasury page finds a
  // mismatch with no way to tell which is right.
  const claim = CLAIM_SOURCES.find((c) => c.symbol === token.symbol);
  assert.ok(claim, "the official token must be the claim source the treasury reads");
  assert.equal(claim.token.toLowerCase(), token.contract.toLowerCase());
});

test("no served provenance calls the official contract not-ours", () => {
  // Every holding row that is the official token or the proceeds of its pool.
  const rows = [
    { asset: "1F916", location: "wallet" as const, chain: "base" as const },
    { asset: "1F916", location: "claimable" as const, chain: "base" as const },
    { asset: "WETH", location: "wallet" as const, chain: "base" as const },
    { asset: "WETH", location: "claimable" as const, chain: "base" as const },
  ];
  for (const row of rows) {
    const prose = provenanceFor(row);
    assert.doesNotMatch(
      prose,
      /not\s+(?:because\s+)?(?:the\s+token\s+is\s+)?ours|not\s+official/i,
      `provenance for ${row.asset}/${row.location} denies ownership of the now-official contract: ${prose}`,
    );
    // And it must not swing the other way: recognition is not endorsement, and
    // a page that drops "did not launch it" is a different lie.
    assert.match(prose, /did not launch it/i, `provenance for ${row.asset}/${row.location} must still say the society did not launch it`);
  }
  // The unsolicited BNB copycat is NOT the official token and must keep saying so.
  const bnb = provenanceFor({ asset: "NVDAB", location: "wallet", chain: "bnb" });
  assert.match(bnb, /does not endorse it/i, "the copycat's disclaimer must survive recognition of a different token");
});

test("the claim source note agrees with the endpoint", () => {
  const claim = CLAIM_SOURCES.find((c) => c.symbol === token.symbol);
  assert.ok(claim);
  assert.doesNotMatch(claim.note, /not\s+because\s+the\s+token\s+is\s+ours/i);
  assert.match(claim.note, /official token/i, "the note must name the recognition it lives beside");
});

// The class-killer. Round 2 of the pre-deploy audit broke the first version of
// this scan three ways, all against real served prose in src/doc.ts, and all
// while the suite stayed green:
//   1. a served line beginning with "*" was skipped as a comment, but "*" also
//      begins a markdown bullet, and doc.ts's served text is full of them.
//   2. per-line matching cannot see a claim that hard-wraps across two lines,
//      and doc.ts hard-wraps everything, so that is the normal case there.
//   3. a stale factual claim in a source COMMENT was not scanned at all.
// So: comments are stripped as REGIONS rather than by leading character, the
// remaining served text is joined and whitespace-normalized before matching,
// and comments are scanned too under a narrower rule. A comment may quote a
// retired sentence (the fix commits do, deliberately) only if it tags the quote
// RETIRED:. An untagged stale claim in a comment is the src/assets.ts:381 defect
// that shipped in the first round of this very change.
const STALE = [
  /there is no official token/i,
  /there is still no official/i,
  /the society has no token/i,
  /official_token (?:is|has been) null/i,
  /not because the token is ours/i,
  /not official and not ours/i,
  /\/api\/official still says/i,
];

// Split a source file into the text a reader is served and the text only a
// developer reads. Block comments are removed as regions; a line whose first
// non-space characters are "//" is a comment line. Everything else is served
// text, joined with spaces so a hard-wrapped sentence matches as one sentence.
export function splitSource(src: string): { served: string; comments: string[] } {
  const withoutBlocks = src.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat(m.split("\n").length - 1));
  const blockLines = new Set<number>();
  {
    let idx = 0;
    for (const line of src.split("\n")) {
      idx += 1;
      void line;
    }
    void idx;
  }
  const comments: string[] = [];
  const servedLines: string[] = [];
  withoutBlocks.split("\n").forEach((text, i) => {
    const t = text.trimStart();
    if (t.startsWith("//")) comments.push(`${i + 1}:${t}`);
    else if (t.length > 0) servedLines.push(t);
  });
  // Block-comment bodies are comment text too, and must be scanned under the
  // RETIRED: rule rather than dropped on the floor.
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) comments.push(m[0]);
  return { served: servedLines.join(" ").replace(/\s+/g, " "), comments };
}

function sourceFiles(): string[] {
  const dir = "src";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

test("no served prose still asserts that this society has no official token", () => {
  const files = sourceFiles();
  assert.ok(files.length > 5, "the scan must actually be reading the source tree");
  const hits: string[] = [];
  for (const file of files) {
    const { served } = splitSource(readFileSync(file, "utf8"));
    for (const pattern of STALE) {
      const m = served.match(pattern);
      if (m) hits.push(`${file}: ...${served.slice(Math.max(0, m.index! - 60), m.index! + 80)}...`);
    }
  }
  assert.deepEqual(hits, [], `served prose still says this society has no official token:\n${hits.join("\n")}`);
});

test("a stale claim hard-wrapped across two served lines is still caught", () => {
  // The exact evasion the auditor demonstrated against src/doc.ts.
  const { served } = splitSource('const doc = `\n  a sentence saying there is no official\n  token here\n`;');
  assert.match(served, /there is no official token/i, "wrapped prose must normalize to one line before matching");
});

test("a served markdown bullet is not mistaken for a comment", () => {
  // The other evasion: "*" begins a bullet in served text as often as it
  // continues a block comment.
  const { served } = splitSource('const doc = `\n* there is no official token\n`;');
  assert.match(served, /there is no official token/i, "a bullet line is served text, not a comment");
});

test("comments may quote a retired claim only if they tag it RETIRED:", () => {
  const files = sourceFiles();
  const hits: string[] = [];
  for (const file of files) {
    const { comments } = splitSource(readFileSync(file, "utf8"));
    for (const c of comments) {
      const flat = c.replace(/\s+/g, " ");
      if (STALE.some((p) => p.test(flat)) && !/RETIRED:/.test(flat)) {
        hits.push(`${file} ${flat.slice(0, 140)}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `a source comment states, untagged, that this society has no official token. Tag the quote RETIRED: if it is history, or fix it if it is a live claim:\n${hits.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Third layer, added 2026-08-28 with PR #165: the same response must not
// PROMISE never to do the thing it is doing.
//
// The two layers above check that served prose about the contract agrees with
// official_token. They did not catch the inverse: official_token named a
// contract while two will_never fields in the SAME payload promised to
// "endorse a token, ask for keys or funds, or DM anyone". A reader checking us
// against our own record hits a response that names a token and swears off
// naming one. 0xRyanC filed it as #165; nothing here caught it, because these
// guards were looking for prose that contradicts the contract's PROVENANCE,
// not for a promise that contradicts its EXISTENCE.
//
// The anti-phishing force has to survive the fix. These fields exist so an
// impostor account is checkable as fake in one request, and weakening them to
// resolve a contradiction would trade a real defence for a tidy sentence. So
// both halves are pinned: the promise still refuses promotion, key and fund
// requests, and DMs, AND it draws the record-versus-recommendation line that
// makes naming official_token consistent with it.
//
// Killing mutations, each measured red: restore "endorse a token" to either
// will_never (reds 3); delete the record-not-a-recommendation clause (reds 1);
// drop the DM refusal (reds 1).

const ENDORSEMENT_CHANNELS = ["official_x_account", "official_subreddit"] as const;
// `as never` rather than `as Env`: this file does not import Env, tsx erases the
// annotation either way, and tsconfig covers only src/** so nothing would have
// caught the dangling type reference.
const channelFacts = () => officialFacts({} as never) as unknown as Record<string, Record<string, string>>;

test("no channel promises never to endorse a token while the same response names one", () => {
  const f = channelFacts();
  assert.ok(f.official_token?.contract, "official_token must name a contract for this test to mean anything");
  for (const c of ENDORSEMENT_CHANNELS) {
    const promise = f[c]?.will_never;
    assert.ok(promise, `${c} must carry a will_never`);
    assert.doesNotMatch(
      promise,
      /\bendorse a token\b/i,
      `${c}: this response NAMES official_token, so a blanket "endorse a token" promise contradicts it`,
    );
  }
});

test("the anti-phishing promise keeps every commitment that actually protects a reader", () => {
  const f = channelFacts();
  for (const c of ENDORSEMENT_CHANNELS) {
    const p = f[c].will_never.toLowerCase();
    assert.match(p, /promote or recommend any asset/, `${c}: must still refuse promotion outright`);
    assert.match(p, /keys or funds/, `${c}: must still refuse key and fund requests`);
    assert.match(p, /dm anyone/, `${c}: must still refuse DMs`);
    assert.match(p, /is not us/, `${c}: must still tell a reader what an account doing so is`);
  }
});

test("naming the token is drawn as a record, not a recommendation", () => {
  const f = channelFacts();
  for (const c of ENDORSEMENT_CHANNELS) {
    const p = f[c].will_never;
    assert.match(p, /not a recommendation/i, `${c}: the distinction is what makes naming a contract consistent with refusing to promote one`);
    assert.match(p, /official_token/, `${c}: and it must point at the field it is reconciling with`);
  }
});

// ---------------------------------------------------------------------------
// Fourth layer, added 2026-08-31. The STALE list above is a list of SENTENCES,
// and it only ever catches a denial phrased the way a past defect phrased it.
//
// WHAT GOT THROUGH. src/doc.ts:104, the route-table line for /api/official on
// the front page, read "(real addresses; there is no token — check scams
// against this)" from the day that endpoint existed until 2026-08-31. It was
// corrected once, by ae045f94 on 2026-08-24, which was reverted eleven minutes
// later in 49e19e9e for a reason that had nothing to do with this line: the
// recognition decision was the owner's and had not been taken. The re-land the
// next day, 8f76510e, was written fresh against the treasury paragraph further
// down this same file and never picked the route-table line back up. So for six
// days the index line pointing AT /api/official denied what /api/official
// served, one screen above it, in the same response.
//
// Every guard above was green throughout. Not one STALE pattern matches the
// words "there is no token": they all require "official" or "the society" next
// to the denial, and this sentence carries neither. A list of remembered
// sentences cannot catch the phrasing nobody wrote down yet.
//
// So this layer matches the SHAPE instead: a denial of a token's existence,
// flagged only when the surrounding 140 characters are talking about the coin
// (official, contract, scam, treasury, Base, an address) rather than about a
// credential or a pagination cursor. That distinction is what keeps it quiet:
// "no token of any other kind is minted" (doc.ts, about access tokens), "Window
// mode emits no token until" (society.ts, about cursors) and connect.ts's
// "There is no token" (about the host secret) are all real, correct sentences,
// and a guard that shouts at them is a guard that gets bypassed.
//
// KILLING MUTATION, measured: restore the reverted doc.ts:104 wording and this
// goes red while every other test in this file stays green.
const TOKEN_DENIAL = /\b(?:there is (?:still )?no|has no|owns no|society has no|is no)\s+(?:official\s+)?token\b/gi;
const COIN_CONTEXT = /official|contract|scam|coin|\bbase\b|treasury|0x[0-9a-fA-F]{6}/i;

function denialsInCoinContext(text: string): string[] {
  const hits: string[] = [];
  TOKEN_DENIAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_DENIAL.exec(text))) {
    const window = text.slice(Math.max(0, m.index - 140), m.index + 140);
    if (COIN_CONTEXT.test(window)) hits.push(window);
  }
  return hits;
}

test("no served sentence denies the token's existence while talking about the coin", () => {
  const files = sourceFiles();
  assert.ok(files.length > 5, "the scan must actually be reading the source tree");
  const hits: string[] = [];
  for (const file of files) {
    const { served } = splitSource(readFileSync(file, "utf8"));
    for (const w of denialsInCoinContext(served)) hits.push(`${file}: ...${w}...`);
  }
  assert.deepEqual(hits, [], `served prose denies the official token's existence:\n${hits.join("\n")}`);
});

test("the shape scan catches the exact line that shipped for six days", () => {
  // Not a hypothetical. This is doc.ts:104 as it was served until 2026-08-31.
  const reverted =
    "What is official:  GET ${origin}/api/official  (real addresses; there is no token — check scams against this)";
  assert.equal(
    denialsInCoinContext(reverted).length,
    1,
    "the route-table line that contradicted /api/official for six days must be caught",
  );
  // And it must be caught by SHAPE, not because someone added it to STALE.
  assert.ok(
    !STALE.some((p) => p.test(reverted)),
    "if a STALE sentence now matches this line, this test is no longer proving the shape scan works",
  );
});

test("the shape scan stays silent on tokens that are not the coin", () => {
  // These are the real sentences in src/ that a blunt /no token/ would flag.
  // A guard with false positives is a guard that gets switched off.
  for (const benign of [
    "the access token the host receives is that citizen's secret, unchanged. No token of any other kind is minted or stored; revoke by rotating the secret",
    "Window mode emits no token until a live row exists, like the id cursors",
    "Nothing new is stored. There is no token to leak, and nothing to revoke separately",
  ]) {
    assert.deepEqual(
      denialsInCoinContext(benign),
      [],
      `the shape scan must not fire on a sentence about credentials or cursors: ${benign}`,
    );
  }
});
