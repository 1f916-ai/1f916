import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";

// A FRIENDLY HINT, NOT THE ENFORCEMENT. The enforcement is
// test/helpers/offline.mjs, which `npm test` loads via NODE_OPTIONS and which
// severs fetch, net, tls and dns so the deterministic suite physically cannot
// reach anything. This file stays because it fails earlier and says something
// more useful than a socket error, and because it names the convention. But it
// greps source, and a grep over source is a floor: pre-publication review walked
// seven ways around it in one sitting, including appending a raw fetch to a file
// that already names the helper and is therefore already considered gated. Do
// not add anything here that the offline guard does not also catch, and do not
// read a green run of this file as proof that the suite is offline.
//
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
// and does not import ./helpers/live.ts -> red. Works at any depth: putting it
// in test/live/ has to be red too, or the guard dies the day the files move.
// Recursive, and that is load-bearing rather than tidy. The first version read
// test/ without descending, so a probe moved into test/live/ would have walked
// straight out from under the guard, and test/live/ is exactly where #151 asks
// for these files to go. A guard that stops working at the moment its subject
// moves is worse than none, because it keeps reporting green.
function testFiles(dir: URL, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      found.push(...testFiles(new URL(`${entry.name}/`, dir), `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith(".ts")) {
      // Every .ts under test/, not only *.test.ts. A helper that opens the
      // socket and is imported by a test is the same socket in the same run,
      // and scanning only test files let one through: test/helpers/zz.ts
      // exporting a bare fetch() was invisible to the first two versions.
      found.push(prefix + entry.name);
    }
  }
  return found;
}

test("every test that reads the deployment is behind the live-probe gate", () => {
  const dir = new URL("./", import.meta.url);
  const offenders: string[] = [];
  for (const f of testFiles(dir)) {
    // helpers/live.ts is the one file that is SUPPOSED to open the socket; it
    // is the gate itself, and requiring it to import itself is nonsense.
    if (f === "helpers/live.ts") continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    // The tell is GLOBAL fetch, not worker.fetch. Most of this suite names the
    // live origin while never leaving the process: it builds Request objects
    // against that origin and hands them to the Worker under test, which is a
    // local call and belongs in the deterministic suite. Only an unqualified
    // fetch( or liveFetch( actually opens a socket, so the check is for those
    // and not for the hostname.
    if (!/https:\/\/1f916\.ai/.test(src)) continue;
    // The lookbehind excludes worker.fetch(, which is the point, but it also
    // excluded globalThis.fetch( and self.fetch(, which are the real thing.
    // Measured before this line changed: a file calling globalThis.fetch on the
    // live origin left the gate at 2 pass, 0 fail while npm test ran it.
    const opensASocket =
      /(?<![.\w])(fetch|liveFetch)\s*\(/.test(src) || /(?:globalThis|global|self)\.fetch\s*\(/.test(src);
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
