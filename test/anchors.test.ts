// Anchors (src/anchors.ts): the pure parts, tested against what the standard
// tools expect rather than against ourselves.
//
// Killing mutations, each checked in a scratch copy before this file was
// committed:
//   - change one byte of OTS_MAGIC, or OTS_OP_SHA256 to 0x02 (sha1): the
//     header test goes red, because it compares against the bytes
//     python-opentimestamps writes, not against the constant.
//   - drop the `digest.length !== 32` guard: the short-digest test goes red.
//   - make baseCalldata skip the 0x prefix or pad wrongly: the roundtrip and
//     the exact-hex tests go red.
//   - make anchorsDue ignore `existing`: the dedupe test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { anchorsDue, baseCalldata, otsFile, payloadFromCalldata, sha256Bytes, OTS_MAGIC } from "../src/anchors.ts";
import { checkpointPayload } from "../src/checkpoint.ts";

const te = new TextEncoder();

test("otsFile is header magic, version 1, sha256 op, digest, calendar bytes", () => {
  const digest = new Uint8Array(32).map((_, i) => i);
  const cal = new Uint8Array([0xf0, 0x10, 0xaa, 0xbb]);
  const f = otsFile(digest, cal);
  // The literal header python-opentimestamps writes (HEADER_MAGIC), then 0x01.
  const magic = new Uint8Array([0x00, ...te.encode("OpenTimestamps"), 0x00, 0x00, ...te.encode("Proof"), 0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94]);
  assert.deepEqual(Array.from(f.slice(0, magic.length)), Array.from(magic));
  assert.deepEqual(Array.from(OTS_MAGIC), Array.from(magic));
  assert.equal(f[magic.length], 0x01, "major version varint");
  assert.equal(f[magic.length + 1], 0x08, "OpSHA256 tag");
  assert.deepEqual(Array.from(f.slice(magic.length + 2, magic.length + 34)), Array.from(digest));
  assert.deepEqual(Array.from(f.slice(magic.length + 34)), Array.from(cal));
  assert.equal(f.length, magic.length + 2 + 32 + cal.length);
});

test("otsFile refuses a digest that is not 32 bytes and an empty calendar response", () => {
  assert.throws(() => otsFile(new Uint8Array(31), new Uint8Array([1])), /32 bytes/);
  assert.throws(() => otsFile(new Uint8Array(32), new Uint8Array(0)), /empty/);
});

test("the anchored digest is SHA-256 of the checkpoint payload text, nothing else", async () => {
  const payload = checkpointPayload("identity_events", 20055, "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde", 1790302872840);
  assert.equal(payload, "1f916.checkpoint.v1:identity_events:20055:e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde:1790302872840");
  const d = await sha256Bytes(payload);
  const expect = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(payload)));
  assert.deepEqual(Array.from(d), Array.from(expect));
  assert.equal(d.length, 32);
});

test("baseCalldata is 0x plus the UTF-8 bytes of the payload, and decodes back exactly", () => {
  const payload = "1f916.checkpoint.v1:ledger:11:ce96f39e:1788327958382";
  const data = baseCalldata(payload);
  assert.match(data, /^0x[0-9a-f]+$/);
  assert.equal(data.length, 2 + payload.length * 2, "one byte per ASCII character");
  assert.equal(data.slice(0, 12), "0x3166393136", "'1f916' in hex");
  assert.equal(payloadFromCalldata(data), payload);
});

test("anchorsDue asks every calendar once per checkpoint and never repeats a recorded target", () => {
  const latest = [
    { id: 10, log: "identity_events", tree_size: 5, root: "aa", created_at: 1 },
    { id: 11, log: "ledger", tree_size: 2, root: "bb", created_at: 2 },
  ];
  const cals = ["https://a", "https://b"];
  const none = anchorsDue(latest, [], { ots: cals, base: true, archive: true });
  assert.equal(none.length, 2 * (2 + 1 + 1));
  const some = anchorsDue(latest, [{ checkpoint_id: 10, kind: "ots", target: "https://a" }, { checkpoint_id: 10, kind: "base", target: "0xdead" }], { ots: cals, base: true, archive: false });
  assert.deepEqual(
    some.map((d) => `${d.checkpoint.id}|${d.kind}|${d.target}`),
    ["10|ots|https://b", "11|ots|https://a", "11|ots|https://b", "11|base|base"],
  );
  const off = anchorsDue(latest, [], { ots: cals, base: false, archive: false });
  assert.ok(off.every((d) => d.kind === "ots"), "no Base or archive rows when neither is enabled");
});
