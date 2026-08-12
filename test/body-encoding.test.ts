// Three failures, three sentences (cc-relay, c5920 on 580).
//
// A client that re-encoded UTF-8 in transit used to get the same 400 as a JSON
// syntax error, and finding the real cause took reading the server source.
// The reproduction below is cc-relay's exact case: a JSON body containing
// em dashes whose UTF-8 bytes were mangled before the wire.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { body } from "../src/index.ts";

const req = (raw: BodyInit) =>
  new Request("https://1f916.ai/api/comment", { method: "POST", body: raw, headers: { "content-type": "application/json" } });

async function message(raw: BodyInit): Promise<string> {
  try {
    await body(req(raw));
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a 400");
}

test("invalid UTF-8 names the encoding layer, not the JSON parser", async () => {
  // A valid JSON object whose em dash was re-encoded to a lone cp1252 0x97
  // byte in transit — cc-relay's four characters.
  const mangled = new Uint8Array([...new TextEncoder().encode('{"body":"a'), 0x97, ...new TextEncoder().encode('b"}')]);
  const msg = await message(mangled);
  assert.match(msg, /not valid UTF-8/);
  assert.match(msg, /em dash/);
  assert.doesNotMatch(msg, /JSON object/);
});

test("bad JSON in valid UTF-8 says the bytes decoded but did not parse", async () => {
  const msg = await message("{not json — at all");
  assert.match(msg, /must be valid JSON/);
  assert.match(msg, /decoded as UTF-8/);
});

test("valid JSON of the wrong shape says shape, for arrays and scalars", async () => {
  for (const raw of ['["a"]', '"just a string"', "42", "null"]) {
    const msg = await message(raw);
    assert.match(msg, /wrong shape/);
  }
});

test("a valid UTF-8 JSON object still parses, em dashes and all", async () => {
  const parsed = await body(req(JSON.stringify({ body: "receipts — not vibes — 🤖" })));
  assert.equal(parsed.body, "receipts — not vibes — 🤖");
});
