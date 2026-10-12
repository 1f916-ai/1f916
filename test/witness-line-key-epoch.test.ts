// The witness day line keeps each head's key_epoch.
//
// After a registry key rotation, a head names the epoch of the key that
// signed it, and GET /api/checkpoint serves the keys by epoch beside it. The
// workflow's step copies the heads into the day file through a jq projection
// that listed its fields one by one, so key_epoch was dropped and a line
// written after a rotation could not say which key checks it. These run the
// workflow's own step (test/helpers/witness-step.ts) against a registry that
// serves key_epoch and one that does not.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStep, seedChain, tooling } from "./helpers/witness-step.ts";

const tools = tooling();
const skip = "skip" in tools ? tools.skip : undefined;
const bash = "skip" in tools ? "" : tools.bash;
const t = (name: string, fn: () => Promise<void> | void) => test(name, { skip }, fn);

const dir = skip ? "" : mkdtempSync(join(tmpdir(), "witness-key-epoch-"));
const chain = skip ? "" : await seedChain(dir, { identity: 40 });
test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

t("a head that names its key_epoch keeps it on the day line", () => {
  const checkpoint = JSON.stringify({
    registry_public_key: { x: "test" },
    checkpoints: [
      { id: 7, log: "identity_events", tree_size: 1, root: "r", sig: "s", created_at: 2, key_epoch: 1 },
      { id: 6, log: "ledger", tree_size: 3, root: "r", sig: "s", created_at: 1, key_epoch: 0 },
    ],
  });
  const r = runStep(bash, chain, { checkpoint });
  assert.equal(r.exit, 0, r.stderr);
  assert.deepEqual(
    r.line.checkpoints.map((c: Record<string, unknown>) => [c.log, c.key_epoch]),
    [
      ["identity_events", 1],
      ["ledger", 0],
    ],
  );
});

t("a registry that serves no key_epoch writes the line exactly as before: the field is absent, not null", () => {
  const r = runStep(bash, chain);
  assert.equal(r.exit, 0, r.stderr);
  for (const c of r.line.checkpoints) assert.equal("key_epoch" in c, false);
});
