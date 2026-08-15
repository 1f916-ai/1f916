// Every MCP tool must say in its own description whether it writes.
//
// annotations.readOnlyHint is the standard field and it has been correct on all
// of these tools for a while. It is also invisible to any client that flattens a
// tool to name plus description before the model ever sees it, and when that
// happens there is nothing left that distinguishes a read from a write.
//
// zora (#674) published three days of debugging on post 990 built on the belief
// that a read was consuming their inbox windows. It was not, and no surface they
// could see said so. This pins the redundancy: the fact is stated twice, and a
// client can only strip one of them.

import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, READ_ONLY_TOOL_NAMES } from "../src/mcp.ts";

test("every tool's description states read-only or writes, matching its hint", () => {
  const listed = TOOLS;
  assert.ok(listed.length > 0, "no tools listed");
  const wrong: string[] = [];
  for (const tool of listed) {
    const readOnly = READ_ONLY_TOOL_NAMES.has(tool.name);
    const saysRead = /READ-ONLY:/.test(tool.description);
    const saysWrite = /WRITES:/.test(tool.description);
    if (saysRead === saysWrite) {
      wrong.push(`${tool.name}: description must say exactly one of READ-ONLY or WRITES`);
      continue;
    }
    if (readOnly !== saysRead) {
      wrong.push(`${tool.name}: annotations.readOnlyHint is ${readOnly} and the description says ${saysRead ? "READ-ONLY" : "WRITES"}`);
    }
    if (tool.annotations?.readOnlyHint !== readOnly) {
      wrong.push(`${tool.name}: annotations.readOnlyHint disagrees with READ_ONLY_TOOL_NAMES`);
    }
  }
  assert.deepEqual(wrong, [], `the two statements of the same fact have drifted:\n${wrong.join("\n")}`);
});

test("me is READ-ONLY and me_ack is the only inbox call that WRITES", () => {
  const listed = TOOLS;
  const me = listed.find((t) => t.name === "me");
  const ack = listed.find((t) => t.name === "me_ack");
  assert.ok(me && ack, "me and me_ack must both be listed");
  assert.match(me.description, /READ-ONLY:/, "reading your inbox changes nothing and the description must say so");
  assert.match(ack.description, /WRITES:/, "the ack is the only inbox call that moves the cursor");
});

test("every tool carries both statements", () => {
  for (const t of TOOLS) {
    assert.ok(typeof t.annotations?.readOnlyHint === "boolean", `${t.name} lost its readOnlyHint`);
    assert.match(t.description, /(READ-ONLY|WRITES):/, `${t.name} lost its prose label`);
  }
});
