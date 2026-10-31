// SQL string-literal extractor for scan-guard, split out so it can be unit
// tested (scan-guard.mjs runs the whole guard on import and cannot be imported
// into a test). Returns each string/template literal's STATIC parts, with every
// `${...}` interpolation reduced to a single "\u0000" marker.
//
// String literals are scanned rather than regex-matched because SQL here is
// often a template whose `${...}` holds a ternary with its own quotes or a
// nested template, which a regex cuts in half.
//
// WQ-679 (schrodingers-bugs, PR#678 body): the tokenizer must also skip REGEX
// literals and comments, in both top-level code and inside `${...}`
// interpolations. A regex such as `.replace(/"/g, ...)` inside an interpolation
// otherwise has its internal quote read as a string open, which desynced the
// scanner from src/society.ts:682 onward and hid 36 SELECT literals from the
// coverage check. (The unbounded-read guard reads captured runtime SQL, not
// these literals, so an unbounded read that actually runs was never hidden;
// what was hidden was source literals no test executes.)
export function sqlLiterals(code) {
  const out = [];
  let i = 0;
  let lastSig = ""; // last non-whitespace char emitted, to tell a regex `/` from division
  let regexAfterComment = null;
  let controlKeyword = "";
  let statementRegex = false; // a control-header close or a throw operand allows `/re/`
  let parens = []; // true only for the condition parentheses of if/while/for
  const mark = (ch) => {
    lastSig = ch;
    regexAfterComment = null;
    controlKeyword = "";
    statementRegex = false;
  };
  // WQ-679/PR#680 follow-up: track control headers, not arbitrary closing
  // parentheses. Calls/groups followed by `/` still mean division. Whole words
  // keep identifier suffixes and public/private member names out of this context.
  const wordChar = (ch) => ch !== undefined && /[$\w\u0080-\uffff]/.test(ch) && !/\s/.test(ch);
  const advanceToken = () => {
    const ch = code[i];
    if (wordChar(ch)) {
      const start = i;
      while (wordChar(code[i])) i++;
      const word = code.slice(start, i);
      const member = lastSig === "." || lastSig === "#";
      const control = !member && /^(if|while|for)$/.test(word)
        ? word : controlKeyword === "for" && word === "await" ? "for" : "";
      // Recognize a standalone throw operand, not a suffix or member value.
      // In particular this.#throw / 3 must not hide a following SQL literal.
      const throwOperand = !member && word === "throw";
      mark(code[i - 1]);
      controlKeyword = control;
      statementRegex = throwOperand;
      return;
    }
    if (ch === "(") {
      parens.push(controlKeyword !== "");
      mark(ch);
    } else if (ch === ")") {
      const control = parens.pop() ?? false;
      mark(ch);
      statementRegex = control;
    } else if (!/\s/.test(ch)) mark(ch);
    i++;
  };
  // JS keywords after which a `/` begins a regex even though the preceding char
  // is a word character (e.g. `return /re/`).
  const KEYWORD_BEFORE_REGEX = /(?:^|[^.\w])(return|typeof|instanceof|in|of|case|do|else|void|delete|yield|await)$/;
  const atRegex = () => {
    if (regexAfterComment !== null) return regexAfterComment;
    if (statementRegex) return true;
    if (lastSig === "" || "([{,;:=!&|?+-*%<>~^".includes(lastSig)) return true;
    return KEYWORD_BEFORE_REGEX.test(code.slice(Math.max(0, i - 12), i).replace(/\s+$/, ""));
  };
  const skipRegex = () => {
    // i is at the opening `/`. Walk to the closing `/` (not inside a [...] class),
    // honoring `\` escapes; then skip trailing flags. A regex never spans a line.
    i++;
    let inClass = false;
    while (i < code.length && code[i] !== "\n") {
      const c = code[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) { i++; break; }
      i++;
    }
    while (i < code.length && /[a-z]/i.test(code[i])) i++;
  };
  const skipComment = () => {
    if (code[i] !== "/" || (code[i + 1] !== "/" && code[i + 1] !== "*")) return false;
    // Trivia does not turn division into a regex, nor erase a preceding
    // keyword's regex context when the keyword falls outside the lookbehind.
    const allowRegex = atRegex();
    if (code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
    } else {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
    }
    regexAfterComment = allowRegex;
    return true;
  };
  const skipInterpolation = () => {
    // i is just past "${"; walk to the matching "}", skipping nested strings,
    // templates, regexes and comments so their braces/quotes do not mislead depth.
    let depth = 1;
    // Interpolations own balanced parentheses; preserve any frame surrounding
    // the enclosing template rather than consuming or discarding it.
    const outerParens = parens;
    parens = [];
    // Each ${...} starts an expression; a previous interpolation or the tag
    // before this template must not determine how its first slash is read.
    mark("");
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (skipComment()) continue;
      if (ch === "`") { readTemplate(); mark("`"); continue; }
      if (ch === '"' || ch === "'") { readQuoted(ch); mark(ch); continue; }
      if (ch === "/" && atRegex()) { skipRegex(); mark("/"); continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      advanceToken();
    }
    parens = outerParens;
  };
  const readQuoted = (q) => {
    let text = "";
    i++;
    while (i < code.length && code[i] !== q && code[i] !== "\n") {
      if (code[i] === "\\") { text += code[i + 1] ?? ""; i += 2; continue; }
      text += code[i++];
    }
    i++;
    return text;
  };
  function readTemplate() {
    let text = "";
    i++;
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") { text += code[i + 1] ?? ""; i += 2; continue; }
      if (code[i] === "$" && code[i + 1] === "{") { i += 2; skipInterpolation(); text += "\u0000"; continue; }
      text += code[i++];
    }
    i++;
    return text;
  }
  while (i < code.length) {
    const ch = code[i];
    if (skipComment()) continue;
    if (ch === "`") { out.push(readTemplate()); mark("`"); continue; }
    if (ch === '"' || ch === "'") { out.push(readQuoted(ch)); mark(ch); continue; }
    if (ch === "/" && atRegex()) { skipRegex(); mark("/"); continue; }
    advanceToken();
  }
  return out;
}
