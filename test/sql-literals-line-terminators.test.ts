// A JavaScript line comment ends at any ECMAScript line terminator, not only LF.
// Compile and execute each fixture: the SQL the real SQLite reader reaches must
// remain visible to the source-coverage helper. This is test infrastructure,
// not a deployed Worker or SQL-injection reproduction.
import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { sqlLiterals } from "./helpers/sql-literals.mjs";

const query = "SELECT id FROM posts WHERE id = 1";
const call = `read(${JSON.stringify(query)});`;
const comment = '// "SELECT phantom FROM comments"';
const endings = [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
  ["line separator", "\u2028"],
  ["paragraph separator", "\u2029"],
] as const;

function runtimeReads(code: string): string[] {
  const script = new Script(code); // Invalid fixture syntax is not a scanner RED.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY); INSERT INTO posts VALUES (1)");
  const reads: string[] = [];
  try {
    script.runInNewContext({
      read(sql: string) {
        assert.ok(db.prepare(sql).get(), "the fixture reaches an actual SQLite read");
        reads.push(sql);
      },
    }, { timeout: 1000 });
    return reads;
  } finally {
    db.close();
  }
}

function check(code: string, expected = query) {
  const reached = runtimeReads(code);
  assert.deepEqual(reached, [expected], "runtime independently establishes the intended read");
  const extracted = sqlLiterals(code).filter((literal: string) => /^\s*SELECT\b/.test(literal));
  assert.deepEqual(extracted, reached, "line-comment trivia must not hide a real read or invent a quoted one");
}

const contexts: [string, (ending: string) => string][] = [
  ["ordinary code", ending => `${comment}${ending}${call}`],
  ["division after trivia", ending => `const n = 12 ${comment}${ending}/ 3; ${call}`],
  ["regex after trivia", ending => `const kind = typeof ${comment}${ending}/"/; ${call}`],
  ["template interpolation", ending => "const label = `value ${1 " + comment + ending + " + 1}`; " + call],
];

for (const [context, code] of contexts) {
  for (const [name, ending] of endings) {
    test(`SQL scanner line comments: ${context}, ${name}`, () => check(code(ending)));
  }
}

for (const [name, separator] of endings.slice(3)) {
  test(`SQL scanner preserves ${name} inside an ordinary quoted string`, () => {
    const sql = `SELECT '${separator}' AS marker`;
    check(`read(${JSON.stringify(sql)});`, sql);
  });
}

test("SQL scanner keeps an unterminated-at-EOF line comment suppressed", () => {
  check(`${call} ${comment}`);
});

test("SQL scanner keeps all line terminators inside a block comment suppressed", () => {
  check(`/* ${comment}\r\n\u2028\u2029 */ ${call}`);
});

for (const [name, whitespace] of [
  ["TAB", "\t"], ["VT", "\v"], ["FF", "\f"], ["NEL", "\u0085"],
  ["NBSP", "\u00a0"], ["BOM", "\ufeff"],
]) {
  test(`SQL scanner keeps ${name} inside a line comment`, () => {
    check(`${comment}${whitespace}"SELECT phantom FROM comments"\n${call}`);
  });
}
