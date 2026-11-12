// The nulls-margin paragraph in society.ts (above the nulls stream's seek)
// argues that every recordNull row is stamped inside the request that writes
// it, and it supports that by naming the call sites: how many there are and
// which functions hold them. That paragraph has drifted three times: it said
// six sites for a month after the journal site landed, it cited line numbers
// that moved (#662), and its rewrite named commitWithModLogReturning for the
// tombstone row, a delegate whose body never calls recordNull. A reader who
// searches the named function finds nothing and has to rebuild the argument.
//
// This test keeps the paragraph's two checkable claims tied to the code: the
// number of sites it states equals the number of recordNull( calls under src/,
// and each function it names as holding a site contains one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// The functions the paragraph names as holding a recordNull call. The router
// and MCP catches are named by what they are, not by a function, so the count
// check covers them.
const NAMED_SITES: Array<[file: string, fn: string]> = [
  ["src/society.ts", "commitModLog"],
  ["src/society.ts", "rotateKey"],
  ["src/society.ts", "createComment"],
  ["src/journal.ts", "writeJournalEntry"],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

// A top-level function's body: from its declaration to the first line that is
// a lone closing brace at column 0, which is how every top-level function in
// src/ ends.
function functionBody(src: string, fn: string): string | null {
  const decl = new RegExp(`^(?:export )?(?:async )?function ${fn}\\b`, "m").exec(src);
  if (!decl) return null;
  const end = src.indexOf("\n}\n", decl.index);
  return src.slice(decl.index, end === -1 ? undefined : end);
}

const paragraph = (() => {
  const society = readFileSync(join(root, "src/society.ts"), "utf8");
  const start = society.indexOf("recordNull call sites");
  assert.ok(start !== -1, "the nulls-margin paragraph in society.ts no longer says how many recordNull call sites there are");
  // Paragraphs in that comment block are separated by a bare "//" line.
  return society.slice(society.lastIndexOf("\n//\n", start), society.indexOf("\n//\n", start));
})();

test("the nulls-margin paragraph states the real number of recordNull call sites", () => {
  const stated = /There are (\w+) recordNull call sites/.exec(paragraph);
  assert.ok(stated, "expected 'There are <number> recordNull call sites' in the paragraph");
  const calls: string[] = [];
  for (const file of sourceFiles("src")) {
    readFileSync(join(root, file), "utf8").split("\n").forEach((line, i) => {
      if (line.trimStart().startsWith("//")) return;
      if (/\bfunction recordNull\(/.test(line)) return;
      if (/\brecordNull\(/.test(line)) calls.push(`${file}:${i + 1}`);
    });
  }
  assert.equal(WORDS[stated[1].toLowerCase()], calls.length, `the paragraph says ${stated[1]}; src/ has ${calls.length}: ${calls.join(", ")}`);
});

test("each function the nulls-margin paragraph names holds a recordNull call", () => {
  for (const [file, fn] of NAMED_SITES) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(paragraph), `the paragraph no longer names ${fn}; update NAMED_SITES with it`);
    const body = functionBody(readFileSync(join(root, file), "utf8"), fn);
    assert.ok(body, `${fn} is not a top-level function in ${file}`);
    assert.match(body, /\brecordNull\(/, `${fn} in ${file} has no recordNull( call, but the paragraph says it holds one`);
  }
});
