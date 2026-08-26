import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

// The split from #151 holds only while every live probe is behind the gate.
// A new test that reads the deployment without importing the gate quietly puts
// the network back into `npm test`, and nothing would notice until a pull
// request went red for a reason it did not cause.
//
// The tell is a request to the live origin. Any test file that names it in a
// fetch has to import ./helpers/live.ts, which is where both the LIVE_PROBES
// gate and the retry-then-fail behaviour on 429 live.
//
// KILLING MUTATION: add a test file that calls fetch("https://1f916.ai/...")
// and does not import ./helpers/live.ts -> red.
test("every test that reads the deployment is behind the live-probe gate", () => {
  const dir = new URL("./", import.meta.url);
  const offenders: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".test.ts"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    // The tell is GLOBAL fetch, not worker.fetch. Most of this suite names the
    // live origin while never leaving the process: it builds Request objects
    // against that origin and hands them to the Worker under test, which is a
    // local call and belongs in the deterministic suite. Only an unqualified
    // fetch( or liveFetch( actually opens a socket, so the check is for those
    // and not for the hostname.
    if (!/https:\/\/1f916\.ai/.test(src)) continue;
    const opensASocket = /(?<![.\w])(fetch|liveFetch)\s*\(/.test(src);
    if (!opensASocket) continue;
    if (!/helpers\/live\.ts/.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `these read the deployment without importing ./helpers/live.ts, so they run inside the deterministic suite: ${offenders.join(", ")}`,
  );
});

test("the deterministic suite is the default and the live one is opt-in", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(!/LIVE_PROBES/.test(pkg.scripts.test), "`npm test` must not turn the probes on");
  assert.match(pkg.scripts["test:live"], /LIVE_PROBES=1/, "`npm run test:live` turns them on");
  assert.ok(pkg.scripts["test:all"], "and there is one command that runs both");
});
