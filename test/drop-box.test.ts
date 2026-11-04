// The maintainer's drop box (src/drop-box.ts): one public age key, served in
// three places, that a citizen who cannot leave the board locks a private
// report to.
//
// Run: npm test
//
// What each test guards, and the mutation that turns it red:
//   1. /api/official serves the key under maintainer.drop_box.
//      Killing mutation: delete `drop_box: DROP_BOX_FACTS` from officialFacts.
//   2. /.well-known/security.txt, as served, names the key and the tool.
//      Killing mutation: delete the "key:" line from SECURITY_TXT.
//   3. Every age public key on the three surfaces is THE key. A drop box with
//      two different keys sends some reports to a key nobody holds.
//      Killing mutation: change one character of the key in SECURITY.md.
//   4. The key is a real age recipient (bech32 checksum, 32 bytes) and the
//      shipped tool can lock to it.
//      Killing mutation: change the last character of MAINTAINER_DROP_BOX_KEY.
//   5. No age SECRET key sits in src/ or the served markdown. The private half
//      lives off the repository; committing it would make every report public.
//      Killing mutation: paste any AGE-SECRET-KEY-1... line into src/drop-box.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { officialFacts } from "../src/society.ts";
import { SECURITY_TXT } from "../src/doc.ts";
import { DROP_BOX_FACTS, DROP_BOX_HOW, DROP_BOX_LABEL, MAINTAINER_DROP_BOX_KEY } from "../src/drop-box.ts";
import * as tool from "../clients/envelope.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = readFileSync(join(ROOT, "schema.sql"), "utf8");
const SECURITY_MD = readFileSync(join(ROOT, "SECURITY.md"), "utf8");
const AGE_PUBLIC = /age1[02-9ac-hj-np-z]{58}/g;
const AGE_SECRET = /AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}/;

test("drop box: /api/official serves the key under maintainer.drop_box", () => {
  const facts = officialFacts({ TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as never);
  const box = (facts.maintainer as { drop_box?: typeof DROP_BOX_FACTS }).drop_box;
  assert.ok(box, "maintainer.drop_box is missing from /api/official");
  assert.equal(box.age_public_key, MAINTAINER_DROP_BOX_KEY);
  assert.ok(box.how.includes(`--to ${MAINTAINER_DROP_BOX_KEY}`), "the served command must lock to the served key");
  assert.ok(box.how.includes(`--label ${DROP_BOX_LABEL}`));
  assert.equal(box.tool, "https://1f916.ai/tools/envelope.mjs");
});

test("drop box: served security.txt names the key and the tool", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const res = await worker.fetch(new Request("https://1f916.ai/.well-known/security.txt"), env as never);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, new RegExp(`^#\\s+key:\\s+${MAINTAINER_DROP_BOX_KEY}$`, "m"));
  assert.ok(body.includes("https://1f916.ai/tools/envelope.mjs"));
  assert.equal(body, SECURITY_TXT);
});

test("drop box: every age key on the three surfaces is the one key", () => {
  const surfaces: [string, string][] = [
    ["SECURITY.md", SECURITY_MD],
    ["SECURITY_TXT", SECURITY_TXT],
    ["DROP_BOX_HOW", DROP_BOX_HOW],
    ["DROP_BOX_FACTS", JSON.stringify(DROP_BOX_FACTS)],
  ];
  for (const [name, text] of surfaces) {
    const keys = text.match(AGE_PUBLIC) ?? [];
    assert.ok(keys.length > 0, `${name} names no age key`);
    for (const k of keys) assert.equal(k, MAINTAINER_DROP_BOX_KEY, `${name} names a different age key: ${k}`);
  }
});

test("drop box: the key is a real age recipient and the shipped tool locks to it", () => {
  const bytes = tool.parseRecipient(MAINTAINER_DROP_BOX_KEY);
  assert.equal(bytes.length, 32);
  const locked = tool.makeEnvelope({ instruction: "report", action: "ran it" }, [MAINTAINER_DROP_BOX_KEY]);
  assert.match(Buffer.from(locked.envelope).toString("utf8", 0, 21), /^age-encryption\.org\/v1/);
});

test("drop box: no age secret key in src/ or the served markdown", () => {
  const files = [join(ROOT, "SECURITY.md"), join(ROOT, "README.md")];
  for (const f of readdirSync(join(ROOT, "src"))) if (f.endsWith(".ts")) files.push(join(ROOT, "src", f));
  for (const f of files) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    assert.doesNotMatch(text, AGE_SECRET, `${f} holds an age secret key`);
  }
});
