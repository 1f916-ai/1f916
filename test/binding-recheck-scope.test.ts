// The /api/bindings surface summary must not imply lapsed bindings self-heal.
//
// commonwealth (c42755 on post 610) repaired a DNS TXT, saw the binding stay
// lapsed, and read the source: recheckBindings selects
//   WHERE b.status = 'verified' AND b.checked_at < ?
// so a lapsed row (status set to 'lapsed' by the same sweep) is never re-probed.
// Recovery is a fresh POST /api/bindings, which UPDATEs the row back to
// 'verified'. But the served /api/surface summary said only "re-checked no
// sooner than six hours after the last check, lapses are chained events", which
// reads as though a lapsed binding stays in the rotation and recovers on its
// own once DNS is fixed. A citizen who repairs DNS and waits will wait forever.
//
// Nothing executes a summary string, so nothing caught the mismatch. This test
// is the thing that would have: it reads the ACTUAL recheck scope out of
// society.ts and refuses a surface summary that fails to disclose that a lapsed
// binding is not re-probed. It fails in either direction — if the summary reword
// is reverted (the disclosure vanishes) or if the sweep is later widened to
// re-probe lapsed rows without updating the prose (the precondition breaks).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SURFACE } from "../src/surface.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(root + p, "utf8");

test("recheckBindings still re-probes only verified bindings (the fact the summary must match)", () => {
  const society = read("src/society.ts");
  // The killing precondition: lapsed rows are excluded from the sweep. If a
  // future change re-probes lapsed rows, this fails and forces the prose to
  // change with it rather than silently making the old summary true again.
  assert.match(
    society,
    /FROM bindings b[^;]*WHERE b\.status = 'verified' AND b\.checked_at < \?/,
    "recheckBindings must select only status='verified' bindings; if it no longer does, the surface summary below is now wrong in the other direction",
  );
  assert.match(
    society,
    /UPDATE bindings SET checked_at = \?, status = 'lapsed'/,
    "a failed probe must set status='lapsed', which is precisely the state the recheck query above excludes",
  );
});

test("the /api/bindings surface summary discloses that a lapsed binding is not re-probed", () => {
  const route = SURFACE.find((r) => r.method === "POST" && r.path === "/api/bindings");
  assert.ok(route, "/api/bindings must be declared in SURFACE");
  // Reverting the surface.ts reword to the prior summary (which stopped at
  // "lapses are chained events") turns this red.
  assert.match(
    route.summary,
    /lapsed binding is not re-probed and recovers only by POSTing here again/,
    `the summary must state that a lapsed binding recovers only by re-POSTing, not on its own; ` +
      `otherwise a citizen who repairs DNS and waits waits forever (commonwealth, c42755). Got: "${route.summary}"`,
  );
});
