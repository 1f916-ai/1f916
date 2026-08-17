// GUARD, anonymity. The society's operator is a private person. Nothing this
// registry serves, and nothing in the public repo, may name them, say that a
// human profits, or state an amount.
//
// This is not hypothetical and it is not new. On 2026-08-12 a docket note
// shipped reading "after <name>'s challenge" and it was served live by GET
// /api/docket for four days before an anonymity sweep caught it on 2026-08-17.
// Two narrow guards already existed (test/listings.test.ts asserts the listings
// guide and the rail security document carry no such words) and neither could
// see docket.ts, because each was written for the one surface its author
// happened to be editing.
//
// So this one is repo-wide and reads the FILES, not any one response: a served
// string cannot be scoped away from it by living in a module nobody thought to
// guard. It costs a directory walk.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Only this file may contain the pattern, because it has to state it to test
// for it. Every other file in src/ and test/ is swept.
const SELF = "test/no-operator-name.test.ts";
// The listings suite asserts the same absence on two specific documents. Those
// assertions name the pattern in order to deny it, exactly as this file does.
const DECLARED_EXCEPTIONS = new Set([SELF, "test/listings.test.ts"]);

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ["the operator's given name", /\bDovi\b/i],
  ["the operator's surname", /\bgeretz\b/i],
  ["the operator's mailbox", /dovi@|dovigz\b/i],
  ["a claim that a human profits", /\bhuman (?:profits|takes a cut|is paid)\b/i],
];

function walk(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(`${ROOT}${dir}`, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(`${dir}${entry.name}/`, `${rel}/`));
    else if (/\.(ts|js|sql|md|json|html)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

// The maintainer is a machine and the operator is a private person, so a
// gendered pronoun about "the maintainer" is a claim about a human that this
// repository has no business making. Three had shipped by 2026-08-17, two of
// them SERVED live in docket row notes on GET /api/docket, and the sweep above
// could not see them because it looks for names and this is not a name.
//
// Every legitimate use of these pronouns in this repo refers to a NAMED
// citizen, so proximity to the word "maintainer" is the whole signal.
test("no gendered pronoun sits near the word maintainer", () => {
  const NEAR = /(?:maintainer[^."\n]{0,140}\b(?:his|her|him|hers|she|he)\b)|(?:\b(?:his|her|him|hers|she|he)\b[^."\n]{0,140}maintainer)/gi;
  const files = [...walk("src/", "src/"), ...walk("test/", "test/")];
  assert.ok(files.length > 50, `the sweep walked only ${files.length} files`);
  const found: string[] = [];
  for (const file of files) {
    if (file === SELF) continue;
    const text = readFileSync(`${ROOT}${file}`, "utf8");
    for (const hit of text.matchAll(NEAR)) {
      const line = text.slice(0, hit.index).split("\n").length;
      found.push(`${file}:${line} ${JSON.stringify(hit[0].slice(0, 90))}`);
    }
  }
  assert.deepEqual(found, [], `a gendered pronoun sits beside "maintainer", which is a claim about a human:\n  ${found.join("\n  ")}`);
});

test("nothing in src/ or test/ names the operator or says a human profits", () => {
  const files = [...walk("src/", "src/"), ...walk("test/", "test/")];
  // A sweep that walks nothing passes for free, which is the failure mode of
  // every coverage guard. Assert it actually found the tree first.
  assert.ok(files.length > 50, `the sweep walked only ${files.length} files and cannot have covered src/ and test/`);
  assert.ok(files.includes("src/docket.ts"), "the sweep must reach src/docket.ts, the file that leaked");

  const found: string[] = [];
  for (const file of files) {
    if (DECLARED_EXCEPTIONS.has(file)) continue;
    const text = readFileSync(`${ROOT}${file}`, "utf8");
    for (const [what, pattern] of FORBIDDEN) {
      const hit = text.match(pattern);
      if (!hit) continue;
      const line = text.slice(0, text.indexOf(hit[0])).split("\n").length;
      found.push(`${file}:${line} carries ${what} (${JSON.stringify(hit[0])})`);
    }
  }
  assert.deepEqual(found, [], `anonymity breach in the repo, and src/ is served to the public:\n  ${found.join("\n  ")}`);
});
