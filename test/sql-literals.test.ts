// WQ-679: scan-guard's SQL-literal tokenizer (test/helpers/sql-literals.mjs)
// must skip regex literals and comments, in top-level code and inside `${...}`
// interpolations, or a regex containing a quote desyncs it and swallows every
// SELECT literal that follows. The live trigger was src/society.ts:682,
// `${check.replace(/"/g, '\\"')}`: the regex's `"` was read as a string open,
// hiding 36 SELECT literals in society.ts from the coverage check.
//
// Killing mutation: remove the `atRegex()`/`skipRegex()` branch from
// sql-literals.mjs (revert to the pre-WQ-679 tokenizer) — the first test here
// goes red because the trailing SELECT is swallowed by the mis-read regex.

import test from "node:test";
import assert from "node:assert/strict";
import { sqlLiterals } from "./helpers/sql-literals.mjs";

const selects = (code: string) =>
  sqlLiterals(code)
    .filter((l) => /^\s*(SELECT|WITH)\b/i.test(l) && /\bFROM\b/i.test(l))
    .map((l) => l.replace(/\s+/g, " ").trim());

test("a regex containing a quote INSIDE a ${} interpolation does not swallow the next SELECT (society.ts:682 shape)", () => {
  const code = [
    "const cmd = `a LaunchAgent [\"/bin/sh\", \"-c\", \"${check.replace(/\"/g, '\\\\\"')} && go\"]`;",
    'const q = env.DB.prepare("SELECT id, body FROM posts WHERE id = ?");',
  ].join("\n");
  assert.deepEqual(selects(code), ["SELECT id, body FROM posts WHERE id = ?"], "the SELECT after the regex-in-interpolation must still be extracted");
});

test("a regex containing a quote in TOP-LEVEL code does not swallow the next SELECT", () => {
  const code = [
    "const s = raw.replace(/'/g, \"X\");",
    'const q = env.DB.prepare("SELECT a FROM t WHERE k = ?");',
  ].join("\n");
  assert.deepEqual(selects(code), ["SELECT a FROM t WHERE k = ?"]);
});

test("division is not mistaken for a regex (the heuristic does not over-skip)", () => {
  // `SNIPPET / 3` is division (preceded by an identifier), not a regex; the
  // SELECT that follows must still be seen.
  const code = [
    "const n = `${SNIPPET_CHARS / 3} rows`;",
    'const q = env.DB.prepare("SELECT c FROM u WHERE id = ?");',
  ].join("\n");
  assert.deepEqual(selects(code), ["SELECT c FROM u WHERE id = ?"]);
});

test("the regex body itself is never emitted as a SQL literal, and plain literals still extract", () => {
  const code = [
    'const re = /SELECT .* FROM nowhere/;', // a regex that LOOKS like SQL must not count
    'const q = env.DB.prepare("SELECT real FROM t");',
  ].join("\n");
  assert.deepEqual(selects(code), ["SELECT real FROM t"], "only the real string literal counts, not the regex body");
});

test("interpolations are reduced to a single marker so a SELECT built by template is one literal", () => {
  const code = 'env.DB.prepare(`SELECT x FROM t WHERE id = ${bind} AND k = ?`);';
  assert.deepEqual(sqlLiterals(code).map((l) => l.replace(/\s+/g, " ").trim()), ["SELECT x FROM t WHERE id = \u0000 AND k = ?"]);
});
