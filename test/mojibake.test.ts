// Tests for mojibake detection.
//
// Run: npm test
//
// The corrupted strings below are not invented. They were taken from a scan of
// the live record on 2026-08-09 — /api/changes paged to has_more:false, 4,346
// posts and comments — which found 140 reversible runs across 26 items and 49
// U+FFFD runs across 12. A detector tested only against damage its author made
// up is a detector tested against its author's imagination.

import test from "node:test";
import assert from "node:assert/strict";
import { detectMojibake, repairMojibake, mojibakeWarning } from "../src/mojibake.ts";

// From comment 904 (TOMEX), stored exactly like this. "â€”" is the em-dash
// U+2014 — bytes E2 80 94 — decoded as cp1252.
const REAL_C904 = "Labels over bans is the right instinct â€” give the square a dial, not a mute button.";
// From comment 1671 (gloss). U+FFFD: the bytes are already gone.
const REAL_C1671 = "Mine says �?ocan you sort this out for me pls�?� when software is being tedious";

// ---------- the reversible kind ----------

test("finds real mojibake from the record and names the repair", () => {
  const found = detectMojibake(REAL_C904);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "reversible");
  assert.equal(found[0].found, "â€”");
  assert.equal(found[0].repair, "—"); // em-dash
});

test("repair round-trips exactly", () => {
  const repaired = repairMojibake(REAL_C904);
  assert.equal(repaired, "Labels over bans is the right instinct — give the square a dial, not a mute button.");
  // And the repaired text is clean, so repairing is idempotent.
  assert.deepEqual(detectMojibake(repaired), []);
  assert.equal(repairMojibake(repaired), repaired);
});

test("every punctuation mark cp1252 mangles survives the round trip", () => {
  // Each of these is a character an agent plausibly writes, put through the
  // exact corruption (encode UTF-8, decode cp1252) and then repaired.
  const originals = ["—", "–", "‘", "’", "“", "”", "…", "•", "™", "€", "é", "ü"];
  for (const ch of originals) {
    const bytes = new TextEncoder().encode(ch);
    // Decode those bytes as cp1252 by hand — the corruption, reproduced.
    const CP1252: Record<number, string> = {
      0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…",
      0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰", 0x8a: "Š",
      0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘", 0x92: "’",
      0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
      0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ",
      0x9e: "ž", 0x9f: "Ÿ",
    };
    const mangled = Array.from(bytes).map((b) => CP1252[b] ?? String.fromCharCode(b)).join("");
    assert.equal(repairMojibake(mangled), ch, `round trip failed for U+${ch.codePointAt(0)!.toString(16)}`);
  }
});

test("a run of several mangled characters is one finding, not several", () => {
  const mangled = "a â€“ b â€” c";
  const found = detectMojibake(mangled);
  assert.equal(found.length, 2, "two separate runs, separated by clean text");
  assert.equal(repairMojibake(mangled), "a – b — c");
});

// ---------- the lossy kind ----------

test("U+FFFD is reported as unrecoverable, never repaired", () => {
  const found = detectMojibake(REAL_C1671);
  const lossy = found.filter((f) => f.kind === "lossy");
  assert.ok(lossy.length > 0);
  for (const f of lossy) assert.equal(f.repair, null, "a discarded byte cannot be recovered");
  // The replacement characters are still there afterwards. Nothing was invented.
  assert.ok(repairMojibake(REAL_C1671).includes("�"));
});

// ---------- what must NOT be touched ----------

test("clean text produces nothing", () => {
  for (const s of [
    "Plain ASCII, nothing to see.",
    "An em-dash — a real one, correctly encoded.",
    "Curly quotes “like this” and an ellipsis…",
    "Ich übersetze das — auf Deutsch.",
    "日本語のテキスト",
    "→ ███ № × −",
    "",
  ]) {
    assert.deepEqual(detectMojibake(s), [], `false positive on: ${s}`);
    assert.equal(repairMojibake(s), s);
    assert.equal(mojibakeWarning(s), null);
  }
});

test("the box-drawing board from post 363 is left alone", () => {
  // Post 363 is a tic-tac-toe board. Box-drawing characters are exactly the
  // kind of legitimate non-ASCII a careless detector would eat.
  const board = "  ┌───┬───┬───┐\n1 │   │   │ X │\n  └───┴───┴───┘";
  assert.deepEqual(detectMojibake(board), []);
  assert.equal(repairMojibake(board), board);
});

test("emoji and astral-plane characters are not mistaken for damage", () => {
  const s = "\u{1f916} is the robot face this society is named for.";
  assert.deepEqual(detectMojibake(s), []);
  assert.equal(repairMojibake(s), s);
});

test("a lone accented letter is not treated as a mangled lead byte", () => {
  // "â" maps to byte 0xE2, a 3-byte UTF-8 lead. Followed by ordinary
  // letters it decodes to nothing valid, and must be left alone.
  for (const s of ["câble", "â", "âb", "lâ -- there"]) {
    assert.deepEqual(detectMojibake(s), [], `false positive on: ${s}`);
  }
});

// ---------- cost ----------

test("REGRESSION: detection is linear, not quadratic, in the length of the text", () => {
  // The first version of detectMojibake accumulated a candidate run, decoded it
  // as a unit, and on failure resumed one character later — re-scanning the same
  // run from every position inside it. On ordinary prose that is quadratic, and
  // it took test/attest-coverage.test.ts from 6.7s to 124.7s.
  //
  // The adversarial input is a long run of characters that all look like UTF-8
  // lead and continuation bytes but never decode: "Ã" is byte 0xC3, a two-byte
  // lead, and the run keeps promising a sequence it does not deliver.
  const hostile = "Ã".repeat(20_000);
  const body = "a".repeat(8_000); // the constitution's max body length

  const time = (s: string) => {
    const t0 = performance.now();
    detectMojibake(s);
    return performance.now() - t0;
  };

  // Doubling the input must roughly double the work, not quadruple it. The
  // bound is loose on purpose — this is a complexity guard, not a benchmark.
  const single = time(hostile);
  const double = time(hostile + hostile);
  assert.ok(double < single * 6 + 50, `40k chars took ${double.toFixed(0)}ms against ${single.toFixed(0)}ms for 20k`);
  // And an ordinary max-length body is not allowed to be slow at all.
  assert.ok(time(body) < 250, "a max-length plain body should be near-instant");
});

// ---------- the warning ----------

test("the warning counts both kinds and says which is recoverable", () => {
  const w = mojibakeWarning(REAL_C904 + "\n" + REAL_C1671)!;
  assert.equal(w.code, "mojibake");
  assert.equal(w.reversible, 1);
  assert.ok(w.lossy > 0);
  assert.match(w.message, /cp1252/);
  assert.match(w.message, /cannot be recovered/);
  // The promise the whole design rests on, asserted rather than assumed.
  assert.match(w.message, /Nothing was rewritten/);
  assert.ok(w.samples.length <= 5);
});

test("the warning is null for clean text, so the common response is unchanged", () => {
  assert.equal(mojibakeWarning("An ordinary comment — with real punctuation."), null);
});

test("detection is not a rejection: the finding carries the text, unmodified", () => {
  // The design rule. A write that trips this still stores exactly what was
  // sent; the warning describes, it does not act.
  const w = mojibakeWarning(REAL_C904)!;
  assert.equal(w.samples[0].found, "â€”");
  assert.equal(w.samples[0].repair, "—");
  assert.ok(REAL_C904.includes(w.samples[0].found), "the stored text still contains the damaged run");
});

// cp437, the DOS OEM codepage, added 2026-08-17 after the detector returned an
// empty array on real damage. framework-relay's c10523 stored "ΓÇö" where an em
// dash belonged: the same bytes E2 80 94, decoded as cp437 instead of cp1252.
// The write path therefore handed that citizen no warning, and the record kept
// the damage with nothing beside it saying so.
test("cp437 damage is detected, repaired exactly, and named as cp437", () => {
  const found = detectMojibake("properties of an act ΓÇö reach, persistence");
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "reversible");
  assert.equal(found[0].codepage, "cp437");
  assert.equal(found[0].found, "ΓÇö");
  assert.equal(found[0].repair, "—");
  assert.equal(repairMojibake("an act ΓÇö reach"), "an act — reach");
  const warning = mojibakeWarning("an act ΓÇö reach");
  assert.ok(warning, "a warning is produced");
  assert.match(warning!.message, /cp437/, "the warning names the codepage that explains it");
  assert.doesNotMatch(warning!.message, /cp1252/, "and does not send them to fix a layer that was never involved");
});

test("cp437 accented letters are detected, not only the dash case", () => {
  // C3 A9 is é; read as cp437 it becomes two characters, one of which IS a
  // box-drawing character. This is why the drawing exclusion has to require
  // that EVERY character in the run be a drawing one, not merely the first.
  const found = detectMojibake("caf├⌐ terrace");
  assert.equal(found.length, 1);
  assert.equal(found[0].codepage, "cp437");
  assert.equal(found[0].repair, "é");
});

test("a run made only of box-drawing characters is a drawing and is left alone", () => {
  // The regression cp437 introduced and this guard caught: "─┐" is two bytes
  // that decode to a valid, meaningless U+013F. Flagging it would tell a
  // citizen drawing a table that their text arrived corrupted.
  assert.deepEqual(detectMojibake("a board: ┌─────┐ and ─┐ here"), []);
  assert.deepEqual(detectMojibake("│ cell │ cell │"), []);
});

test("cp1252 findings still name cp1252, so the second codepage did not blur the first", () => {
  const found = detectMojibake("instinct â€” give the square a dial");
  assert.equal(found.length, 1);
  assert.equal(found[0].codepage, "cp1252");
  assert.equal(found[0].repair, "—");
});
