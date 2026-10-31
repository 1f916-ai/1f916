// Bounded control-parenthesis / throw regex contexts; no fixture is executed.
import test from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { sqlLiterals } from "./helpers/sql-literals.mjs";

const select = "SELECT id FROM posts WHERE id = ?";
const suffix = ` const q = ${JSON.stringify(select)};`;
const check = (code: string, expected: string[]) => {
  new Script(code); // A SyntaxError is fixture failure, never extractor RED.
  assert.deepEqual(sqlLiterals(code), expected);
};

for (const [name, prefix] of [
  ["if", 'if (ok) /"/.test(value);'],
  ["SQL-looking regex", 'if (ok) /"SELECT phantom FROM comments"/.test(value);'],
  ["nested condition", 'if (check((value))) /"/.test(value);'],
  ["trivia", 'if /* condition */ (ok) /* body */ /"/.test(value);'],
  ["while", 'while (ok) /"/.test(value);'],
  ["for", 'for (let n=0; n<1; n++) /"/.test(value);'],
  ["for-of", 'for (const n of values) /"/.test(n);'],
  ["for-await", 'async function f() { for await (const n of values) /"/.test(n); }'],
  ["throw", 'function f() { throw /"/; }'],
  ["throw trivia", 'function f() { throw /* reason */ /"/; }'],
  ["throw long whitespace", 'function f() { throw                     /"/; }'],
  ["throw property division", 'const n = object.throw / 3;'],
  ["throw property trivia division", 'const n = object. /* long property trivia */ throw / 3;'],
  ["throw optional property division", 'const n = object?. /* long property trivia */ throw / 3;'],
  ["throw suffix division", 'const n = αthrow / 3;'],
  ["unicode condition whitespace", 'if\u00a0(ok)\u2003/"/.test(value);'],
  ["astral keyword suffix", 'const n = 𐐀if(value) / 3;'],
  ["class escapes flags", 'if (ok) /["/\\]]+/gi.test(value);'],
  ["nested controls", 'if (ok) while (other) /"/.test(value);'],
  ["condition regex", 'if (/"/.test(value)) /"/.test(value);'],
  ["condition call division", 'if (check(value) / 3) /"/.test(value);'],
  ["line trivia", 'if // first\n (ok) // second\n /"/.test(value);'],
  ["cache invalidation after condition", 'if (ok) value / 3;'],
  ["cache invalidation after comment", 'if (ok) /* body */ value / 3;'],
  ["ordinary call", 'const n = check(value) / 3;'],
  ["property if", 'const n = object.if(value) / 3;'],
  ["property if with trivia", 'const n = object. /* property */ if /* args */ (value) / 3;'],
  ["optional-chain if", 'const n = object?.if(value) / 3;'],
  ["optional-chain while", 'const n = object?.while(value) / 3;'],
  ["property for", 'const n = object.for(value) / 3;'],
  ["group", 'const n = (value) / 3;'],
  ["nested group", 'const n = ((value)) /* units */ / 3;'],
  ["keyword suffix", 'const n = xif(value) / 3;'],
  ["dollar keyword suffix", 'const n = $if(value) / 3;'],
  ["unicode keyword suffix", 'const n = αif(value) / 3;'],
  ["post-if call division", 'if (ok) check(value) / 3;'],
  ["post-if group division", 'if (ok) (value) / 3;'],
] as const) {
  test(`SQL scanner bounded control context: ${name}`, () => check(prefix + suffix, [select]));
}

for (const literal of ['"123"', '`123`']) {
  test(`SQL scanner clears control context after ${literal}`, () => {
    check(`if (ok) ${literal} / 3;` + suffix, ["123", select]);
  });
}

for (const [name, expression, expected] of [
  ["if in IIFE", '`before ${(() => { if (ok) /"}/.test(value); return 1; })()} after`', "before \u0000 after"],
  ["throw in IIFE", '`before ${(() => { throw /"}/; })()} after`', "before \u0000 after"],
  ["ordinary division in interpolation", '`before ${object.if(value) / 3} after`', "before \u0000 after"],
  ["successive expressions", '`one ${value} two ${(() => { if (ok) /"}/.test(value); })()} three`', "one \u0000 two \u0000 three"],
  ["nested templates", '`outer ${tag`inner ${(() => { while (ok) /"}/.test(value); })()}`} end`', "outer \u0000 end"],
] as const) {
  test(`SQL scanner control inside interpolation: ${name}`, () => check(`const label = ${expression};` + suffix, [expected, select]));
}

test("SQL scanner preserves an outer control frame around nested interpolation", () => {
  check('if (check(`first ${value} next ${tag`inner ${value}`}`)) /"/.test(value);' + suffix,
    ["first \u0000 next \u0000", select]);
});
test("SQL scanner preserves an ordinary call frame around nested interpolation", () => {
  check('const n = check(`first ${value} next ${tag`inner ${value}`}`) / 3;' + suffix,
    ["first \u0000 next \u0000", select]);
});
test("SQL scanner retains non-SQL literals and template static parts", () => {
  check('const a = "ordinary"; if (check("condition")) /"SELECT phantom FROM comments"/.test(value); const b = `static ${value} tail`; const c = \'done\';' + suffix,
    ["ordinary", "condition", "static \u0000 tail", "done", select]);
});
// Private names are values too, never control headers or throw operands.
for (const name of ["if", "while", "for", "throw"]) {
  const declaration = name === "throw"
    ? "class C { #throw = 6; f() { const n = this.#throw / 3; } }"
    : `class C { #${name}() { return 6; } f() { const n = this.#${name}() / 3; } }`;
  test(`SQL scanner keeps division after private member #${name}`, () => {
    check(declaration + suffix, [select]);
  });
  test(`SQL scanner keeps private-member division inside interpolation: #${name}`, () => {
    check("const label = `before ${(() => { " + declaration + " return 1; })()} after`;" + suffix,
      ["before \u0000 after", select]);
  });
}

// Identifier escapes stay inside one opaque word; their braces are not code.
for (const prefix of [String.raw`\u{61}`, String.raw`\u{000000000061}`, String.raw`\u0061`,
  String.raw`\u{10400}`, String.raw`a\u{62}`]) {
  for (const name of ["if", "while", "for", "throw"]) {
    const identifier = prefix + name;
    const call = name === "throw" ? "" : "(value)";
    const statements = [
      `const n = ${identifier}${call} / 3;`,
      `const n = object. /* member */ ${identifier}${call} / 3;`,
      name === "throw"
        ? `class C { #${identifier} = 6; f() { const n = this.#${identifier} / 3; } }`
        : `class C { #${identifier}() { return 6; } f() { const n = this.#${identifier}(value) / 3; } }`,
    ];
    for (const interpolate of [false, true]) {
      test(`SQL scanner keeps escaped identifier ${identifier}, interpolation=${interpolate}`, () => {
        for (const statement of statements) {
          const code = interpolate
            ? "const label = `before ${(() => { " + statement + " return 1; })()} after`;"
            : statement;
          check(code + suffix, interpolate ? ["before \u0000 after", select] : [select]);
        }
      });
    }
  }
}
