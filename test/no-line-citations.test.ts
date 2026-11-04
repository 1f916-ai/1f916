// A comment that cites another place in the source as `<file>.ts:<line>` is
// right on the day it is written and wrong after the next edit above that
// line. On 2026-10-25 every such citation outside docket.ts pointed at the
// wrong line: the nulls-margin paragraph in society.ts had drifted twice in
// three days (#662), and the six others named a comment, an interface field
// or a neighboring function instead of the code they meant. Naming the
// function (and, where it helps, the statement) survives edits; a line number
// does not, and nothing tells the reader it has gone stale.
//
// docket.ts is exempt: its rows are dated findings that quote the line
// numbers of the commit they were measured at, and rewriting them would
// change what was recorded.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const EXEMPT = new Set(["src/docket.ts"]);
const LINE_CITATION = /\b[\w-]+\.(?:ts|mjs|js):\d+/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

test("src/ cites other source by function name, not by file:line", () => {
  const found: string[] = [];
  for (const file of sourceFiles("src")) {
    if (EXEMPT.has(file)) continue;
    readFileSync(join(root, file), "utf8").split("\n").forEach((line, i) => {
      const m = LINE_CITATION.exec(line);
      if (m) found.push(`${file}:${i + 1} cites ${m[0]}`);
    });
  }
  assert.deepEqual(found, [], "name the function (and the statement) instead of a line number, which drifts with every edit above it");
});
