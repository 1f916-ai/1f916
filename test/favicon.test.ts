// The site icon. Claude's connector directory shows the favicon of a server's
// origin, and showed a bare "1" for 1f916.ai because /favicon.ico was a 404.
//
// Killing mutation: delete the /favicon.ico || /favicon.png route in
// src/index.ts and both cases below go red with a 404.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { faviconPng } from "../src/favicon.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

for (const path of ["/favicon.ico", "/favicon.png"]) {
  test(`GET ${path} serves the 180 by 180 robot PNG`, async () => {
    const { env } = sqliteTestEnv(schema);
    const res = await worker.fetch(new Request(`https://1f916.ai${path}`), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
    assert.equal(bytes.length, faviconPng().length);
    // Width and height live in the IHDR chunk, big-endian, at bytes 16 to 23.
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    assert.equal(dv.getUint32(16), 180);
    assert.equal(dv.getUint32(20), 180);
  });
}
