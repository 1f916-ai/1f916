import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error a plain JavaScript module with no types: it is a tool, not part of the Worker
import * as tool from "../clients/envelope.mjs";

// WQ-693 (quire, c125614 on #10596): the drop-box client must read the private
// report text from standard input, never from the command line, so a citizen's
// vulnerability report is not left in shell history or process argv. `record`
// reads the report the same way `seal` reads its plaintext (fd 0 or --in).

test("record reads the report from stdin and ignores any --instruction on the command line", async () => {
  const k = tool.keygen();
  const dir = mkdtempSync(join(tmpdir(), "envrec-"));
  const reportPath = join(dir, "report.txt");
  const REPORT = "the private report body, never on argv\n";
  writeFileSync(reportPath, REPORT);

  // Capture the one POST the tool makes and answer it the way the registry does.
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init: { body: string }) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: 7, page: "/api/mandates/7" }), { status: 201 });
  }) as unknown as typeof fetch;
  const prevSecret = process.env.F916_SECRET;
  process.env.F916_SECRET = "1f916_sk_" + "ab".repeat(32);
  try {
    // An --instruction value is passed on argv ON PURPOSE: the fix must ignore
    // it. Before the fix, `record` took the report from this flag.
    await tool.main([
      "record",
      "--to", k.recipient,
      "--label", "drop-box",
      "--action", "ran the probe at commit deadbeef",
      "--instruction", "THIS-MUST-NOT-BE-RECORDED",
      "--in", reportPath,
    ]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevSecret === undefined) delete process.env.F916_SECRET;
    else process.env.F916_SECRET = prevSecret;
  }

  assert.ok(captured, "the tool posted the record");
  const c = captured as { url: string; body: Record<string, unknown> };
  assert.ok(c.url.endsWith("/api/mandates"), "posted to the mandates door");
  // Decrypt the sealed envelope with the owner key and confirm the report text
  // came from stdin, and the argv --instruction value is nowhere in it.
  const envelope = Buffer.from(c.body.envelope as string, "base64");
  const read = tool.readEnvelope(envelope, k.identity);
  assert.equal(read.instruction, REPORT, "the recorded instruction is the stdin report");
  assert.equal(read.action, "ran the probe at commit deadbeef");
  assert.notEqual(read.instruction, "THIS-MUST-NOT-BE-RECORDED", "the argv --instruction is not recorded");
  // The committed fingerprint is of the stdin text, not the argv value.
  assert.equal(c.body.instruction_hash, tool.sha256(REPORT));
});
