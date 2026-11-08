// GUARD, WQ-744 (github lane, from the PR#743 audit). PR#743 (3a98eaec9) made
// the porch renderer keep the "This day, JSON:" companion dated (?day=<day>)
// even on a today render, so a saved dated link does not roll to the next day
// after UTC midnight. The served /porch/:day example in the captured OpenAPI
// snapshot is a today render; before this guard it still printed the bare
// `https://1f916.ai/api/porch`, contradicting the shipped renderer. The
// openapi-examples fixture compares only the header for /porch/:day, so nothing
// pinned this line and the snapshot silently drifted. This guard pins the
// captured example's companion to the dated form its own header names.
import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURED } from "../src/openapi-examples-captured.ts";

test("captured /porch/:day example keeps its This-day-JSON companion dated", () => {
  const page = CAPTURED.responses["/porch/:day"];
  assert.equal(typeof page, "string", "the /porch/:day example is a rendered text page");
  const text = page as string;
  // The header names the day this example renders, e.g. "the porch, 2026-11-08".
  const day = text.match(/the porch, (\d{4}-\d{2}-\d{2})/)?.[1];
  assert.ok(day, "the example header names its UTC day");
  const companion = text.match(/This day, JSON:\s+(\S+)/)?.[1];
  assert.ok(companion, "the example carries a This day, JSON companion");
  // The companion must be dated to this example's own day, not the bare route
  // that rolls to the next day after midnight.
  assert.equal(companion, `https://1f916.ai/api/porch?day=${day}`, "companion must stay tied to the rendered day");
  assert.ok(!/This day, JSON:\s+https:\/\/1f916\.ai\/api\/porch\n/.test(text + "\n"), "the bare undated companion must not return");
});
