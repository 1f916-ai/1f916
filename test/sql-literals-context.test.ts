// SQL coverage must not depend on comments or on a preceding interpolation.
import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { sqlLiterals } from "./helpers/sql-literals.mjs";

const query = 'const q = "SELECT id FROM posts WHERE id = ?";';
const select = "SELECT id FROM posts WHERE id = ?";
const selects = (code: string) => sqlLiterals(code).filter((literal: string) => /^\s*SELECT\b/.test(literal));

for (const [name, prefix] of [
  ["division after a block comment", "const n = value /* units */ / 3;"],
  ["division after adjacent block comments", "const n = value /* first */ /* second */ / 3;"],
  ["division after a string property and comment", 'const n = "123".length /* units */ / 3;'],
  ["division inside an interpolation after a comment", "const label = `count ${value /* units */ / 3}`;"],
  ["regex after a keyword and block comment", 'const kind = typeof /* comment */ /"/;'],
  ["regex after a keyword and line comment", 'const kind = typeof // comment\n /"/;'],
  ["regex after multiline trivia", 'const kind = typeof /* first */\n // second\n /* third */ /"/;'],
  ["division remains division across a line comment", "const n = value // units\n / 3;"],
] as const) {
  test(`SQL scanner preserves slash context: ${name}`, () => {
    const code = prefix + " " + query;
    new Script(code); // Parse, do not execute: invalid fixture syntax is not scanner RED.
    assert.deepEqual(selects(code), [select]);
  });
}

for (const [name, expression] of [
  ["first expression in a tagged template", 'tag`prefix ${/"/.test(value)}`'],
  ["expression following a value interpolation", '`first ${value} second ${/"/.test(value)}`'],
  ["brace regex after a value interpolation", '`first ${value} second ${/}/.test(value)}`'],
  ["nested template expression", '`first ${value} second ${tag`inner ${/"/.test(value)}`}`'],
] as const) {
  test(`SQL scanner starts a fresh template-expression context: ${name}`, () => {
    const code = `const label = ${expression}; ${query}`;
    new Script(code);
    const expected = name === "first expression in a tagged template" ? "prefix \u0000" : "first \u0000 second \u0000";
    assert.deepEqual(sqlLiterals(code), [expected, select]);
  });
}

test("SQL scanner still ignores quotes and SQL-looking text in comments", () => {
  const code = '/* "SELECT fake FROM comments" / */ const n = value /* / */ / 3; ' + query;
  new Script(code);
  assert.deepEqual(selects(code), [select]);
});
