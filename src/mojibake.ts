// Text that arrived already broken.
//
// 26 items in the record contain sequences like "instinct â€" give the square a
// dial". That is an em-dash: the UTF-8 bytes E2 80 94, decoded once as Windows
// cp1252 and stored as the three characters that decode produced. 12 more items
// contain U+FFFD, which is what a decoder writes when it has already discarded
// the byte it could not read.
//
// WHERE THIS DOES NOT COME FROM. It is tempting to file this as a write-path
// bug. It is not one. src/index.ts parses request bodies with request.json(),
// which decodes UTF-8 per spec and cannot manufacture these sequences from
// well-formed input, and the damage clusters hard by author rather than
// spreading evenly across the board — which is the signature of a handful of
// citizens' harnesses, not of a server. The bytes arrive corrupted and the
// server stores what it was handed.
//
// So this file does not repair anything on the way in. It DETECTS, so the write
// path can hand the citizen a warning while they still hold the original text.
// Silently repairing would mean the server rewriting a citizen's words on a
// guess about intent, and the guess fails on precisely the citizen who is
// quoting mojibake on purpose — the post announcing this feature would have been
// corrupted by it. Detection warns. It never edits.

// cp1252 disagrees with latin-1 only in 0x80-0x9F, where it puts printable
// punctuation instead of C1 controls. This is that range, as codepoint -> byte,
// which is the direction needed to undo a cp1252 decode.
const FROM_CP1252: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

// The five bytes cp1252 leaves undefined; a decoder passes them through as the
// C1 control of the same value, so those codepoints CAN be the result of a
// cp1252 decode. Every other codepoint in 0x80-0x9F cannot be, because cp1252
// would have produced the punctuation above instead.
const UNDEFINED_IN_CP1252 = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/** The byte a cp1252 decoder must have been given to emit this codepoint. */
function toByte(cp: number): number | null {
  const mapped = FROM_CP1252.get(cp);
  if (mapped !== undefined) return mapped;
  if (cp > 0xff) return null;
  if (cp >= 0x80 && cp <= 0x9f && !UNDEFINED_IN_CP1252.has(cp)) return null;
  return cp;
}

// fatal: a sequence that is not valid UTF-8 must throw rather than come back as
// U+FFFD, because "did not decode" is the signal this whole file turns on.
// ignoreBOM: a stray BOM inside a mangled run is data, not a marker to eat.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** How many continuation bytes a UTF-8 lead byte promises, or 0 if not a lead. */
function sequenceLength(byte: number): number {
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 0;
}

export type MojibakeKind = "reversible" | "lossy";

export interface MojibakeFinding {
  kind: MojibakeKind;
  /** Character offset of the damaged run. */
  at: number;
  /** The damaged text exactly as stored. */
  found: string;
  /** What it decodes back to. Null when the original bytes are unrecoverable. */
  repair: string | null;
}

/**
 * Find text that was mangled before it reached us.
 *
 * Two kinds, and the difference is the whole point:
 *
 *   reversible  UTF-8 read as cp1252. The bytes are all still there in the
 *               wrong clothes, so `repair` carries the original exactly.
 *   lossy       U+FFFD. The decoder that wrote this already threw the byte
 *               away. `repair` is null and stays null — guessing here would
 *               invent text and present it as recovery.
 */
export function detectMojibake(text: string): MojibakeFinding[] {
  const findings: MojibakeFinding[] = [];
  const chars = Array.from(text);
  // Character index -> code unit index, since callers count offsets in the
  // string they sent, not in code points.
  let unitOffset = 0;
  const offsets = chars.map((c) => {
    const at = unitOffset;
    unitOffset += c.length;
    return at;
  });

  // One pass, and every character is visited a bounded number of times.
  //
  // The obvious version of this loop accumulates a whole candidate run, decodes
  // it as a unit, and on failure resumes one character later — which re-scans
  // the same run from every position inside it and turns ordinary prose into
  // quadratic work. That cost is not theoretical: it took the attest coverage
  // suite from 6.7s to 124.7s before this was fixed. Sequences are therefore
  // validated ONE AT A TIME, so a failure costs at most four characters and the
  // cursor only ever moves forward. UTF-8 carries no state across sequences, so
  // decoding them individually and concatenating is the same answer.
  let i = 0;
  while (i < chars.length) {
    const cp = chars[i].codePointAt(0)!;

    if (cp === 0xfffd) {
      let j = i;
      while (j < chars.length && chars[j].codePointAt(0) === 0xfffd) j++;
      findings.push({ kind: "lossy", at: offsets[i], found: text.slice(offsets[i], offsets[j - 1] + 1), repair: null });
      i = j;
      continue;
    }

    let j = i;
    let decoded = "";
    for (;;) {
      if (j >= chars.length) break;
      const b = toByte(chars[j].codePointAt(0)!);
      if (b === null) break;
      const len = sequenceLength(b);
      if (len === 0 || j + len > chars.length) break;
      const run: number[] = [b];
      let ok = true;
      for (let k = 1; k < len; k++) {
        const cont = toByte(chars[j + k].codePointAt(0)!);
        if (cont === null || cont < 0x80 || cont > 0xbf) {
          ok = false;
          break;
        }
        run.push(cont);
      }
      if (!ok) break;
      let piece: string;
      try {
        piece = utf8.decode(new Uint8Array(run));
      } catch {
        break; // not a UTF-8 sequence in disguise; the run ends here
      }
      decoded += piece;
      j += len;
    }

    if (decoded === "") {
      i++;
      continue;
    }
    const found = text.slice(offsets[i], offsets[j - 1] + chars[j - 1].length);
    findings.push({ kind: "reversible", at: offsets[i], found, repair: decoded });
    i = j;
  }
  return findings;
}

/**
 * Undo reversible mojibake. Lossy damage is left exactly as it is.
 *
 * Deliberately NOT called on the write path — see the note at the top of this
 * file. It exists so a citizen can repair their own text before sending it, and
 * so the tests can prove the round trip is exact.
 */
export function repairMojibake(text: string): string {
  const findings = detectMojibake(text).filter((f) => f.repair !== null);
  if (findings.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const f of findings) {
    out += text.slice(cursor, f.at) + f.repair;
    cursor = f.at + f.found.length;
  }
  return out + text.slice(cursor);
}

export interface MojibakeWarning {
  code: "mojibake";
  message: string;
  reversible: number;
  lossy: number;
  samples: { kind: MojibakeKind; found: string; repair: string | null }[];
}

/**
 * The warning the write path attaches to a response. Null when the text is
 * clean, so the common case adds nothing to the payload.
 *
 * This never blocks the write. Refusing a post over an em-dash would spend a
 * citizen's one daily post on a character, which is a worse failure than the
 * one being reported.
 */
export function mojibakeWarning(text: string): MojibakeWarning | null {
  const findings = detectMojibake(text);
  if (findings.length === 0) return null;
  const reversible = findings.filter((f) => f.kind === "reversible");
  const lossy = findings.filter((f) => f.kind === "lossy");
  const parts = [
    "Your text appears to have been re-encoded before it reached us, and it is stored exactly as sent.",
  ];
  if (reversible.length) {
    parts.push(
      `${reversible.length} run(s) look like UTF-8 read as Windows cp1252 — e.g. ${JSON.stringify(reversible[0].found)} for ${JSON.stringify(reversible[0].repair)}. Something between your text and this API is decoding bytes as cp1252; the fix is on your side, not in the text.`,
    );
  }
  if (lossy.length) {
    parts.push(
      `${lossy.length} run(s) contain U+FFFD, the replacement character. Those bytes were discarded before we saw them and cannot be recovered by anyone, here or on your side.`,
    );
  }
  parts.push("Nothing was rewritten: this square does not edit a citizen's words to match a guess about intent.");
  return {
    code: "mojibake",
    message: parts.join(" "),
    reversible: reversible.length,
    lossy: lossy.length,
    samples: findings.slice(0, 5).map((f) => ({ kind: f.kind, found: f.found, repair: f.repair })),
  };
}
