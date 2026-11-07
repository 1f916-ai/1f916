// Escaped CRLF is one JavaScript line continuation. Its LF must not end the
// scanner's quoted-string walk and turn the real closing quote into a new one.
// Fixtures compile and reach native SQLite before extraction is checked; this
// exercises test infrastructure, not a deployed Worker or full escape decoder.
import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { DatabaseSync } from "node:sqlite";
import { sqlLiterals } from "./helpers/sql-literals.mjs";

const query = "SELECT id FROM posts WHERE id = 1";
const call = `read(${JSON.stringify(query)});`;
const endings = [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"], ["LS", "\u2028"], ["PS", "\u2029"]] as const;
const quotes = [["double", '"'], ["single", "'"]] as const;
const walkers: [string, (declaration: string) => string][] = [
  ["top level", declaration => `${declaration} ${call}`],
  ["template interpolation", declaration => "const label = `value ${(() => { " + declaration + " return marker; })()}`; " + call],
];

function check(code: string) {
  const parsed = new Script(code);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE posts (id INTEGER PRIMARY KEY); INSERT INTO posts VALUES (1)");
  const reached: string[] = [];
  try {
    parsed.runInNewContext({
      read(sql: string) {
        assert.equal(db.prepare(sql).get()?.id, 1, "the fixture executes a real SQLite SELECT");
        reached.push(sql);
      },
    }, { timeout: 1000 });
  } finally {
    db.close();
  }
  assert.deepEqual(reached, [query], "runtime reachability is independent of the source scanner");
  assert.deepEqual(sqlLiterals(code).filter((literal: string) => /^\s*SELECT\b/.test(literal)), reached);
}

for (const [walker, wrap] of walkers) {
  for (const [style, quote] of quotes) {
    for (const [name, ending] of endings) {
      test(`SQL quoted continuation: ${walker}, ${style}, ${name}`, () => {
        check(wrap(`const marker = ${quote}ordinary\\${ending}suffix${quote};`));
      });
    }
    test(`SQL quoted continuation: ${walker}, ${style}, successive CRLF`, () => {
      check(wrap(`const marker = ${quote}first\\\r\nmiddle\\\r\nlast${quote};`));
    });
  }
}

for (const [name, ending] of endings) {
  test(`SQL quoted continuation: existing template-string ${name} path remains aligned`, () => {
    check("const marker = `ordinary\\" + ending + "suffix`; " + call);
  });
}

for (const escape of ["\\n", "\\r", "\\t", "\\u0061"]) {
  test(`SQL quoted continuation: textual escape ${escape} is not a physical line ending`, () => {
    check(`const marker = "ordinary${escape}suffix"; ${call}`);
  });
}

for (const [style, quote] of quotes) {
  test(`SQL quoted continuation: escaped ${style} quote remains inside its string`, () => {
    check(`const marker = ${quote}ordinary\\${quote}suffix${quote}; ${call}`);
  });
}

test("SQL quoted continuation: escaped backslash does not consume its closing quote", () => {
  check('const marker = "ordinary\\\\"; ' + call);
});

for (const [style, quote] of quotes) {
  test(`SQL quoted continuation: ${style} preserves complete static CRLF bytes`, () => {
    const declaration = `const marker = ${quote}first\\\r\nmiddle\\\nlast${quote};`;
    const code = `${declaration} ${call}`;
    check(code);
    assert.deepEqual(sqlLiterals(code), ["first\r\nmiddle\nlast", query]);
    const wrapped = walkers[1][1](declaration);
    check(wrapped);
    assert.deepEqual(sqlLiterals(wrapped), ["value \u0000", query]);
  });
}
