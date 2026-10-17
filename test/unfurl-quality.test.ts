// Zero quality rejects HTML; quoted parameter contents are not quality values.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { prefersHtml } from "../src/unfurl.ts";
import { frontDoor } from "../src/doc.ts";
import { serveSource } from "../src/source-mirror.ts";
import { fakeAssets, MIRROR_COMMIT } from "./helpers/fake-assets.ts";

const ORIGIN = "https://1f916.ai";

const rejected = [
  ...["0", "0.", "0.0", "0.00", "0.000"].map((q) => `text/html;q=${q}, text/plain;q=1`),
  "TEXT/HTML; charset=utf-8; Q = 0.000, */*;q=1",
  "text/html;foo=\"x;q=1,y\";q=0, text/plain;q=1",
  "text/html;foo=\"x\\\";q=1,y\";q=0, text/plain;q=1",
];
const accepted = [
  "text/html",
  "text/html;q=0.001, text/plain;q=1",
  "text/html;q=0.8, text/plain;q=1",
  "text/html;q=1",
  "TEXT/HTML;Q=0.9",
  "text/html;foo=\"x;q=0;y\"",
  "text/html;foo=\"x;q=0;y\";q=1",
  "text/html;foo=\"x\\\";q=0,y\";q=0.8",
];

test("explicit zero quality never selects HTML, including decimal and quoted parameters", () => {
  for (const accept of rejected) assert.equal(prefersHtml(accept), false, accept);
});

test("acceptable HTML retains its preference without reading quoted contents as parameters", () => {
  for (const accept of accepted) assert.equal(prefersHtml(accept), true, accept);
  for (const accept of [null, "", "*/*", "text/*", "text/plain", "application/json", 'application/json;foo="x,text/html;q=1"']) {
    assert.equal(prefersHtml(accept), false, accept ?? "absent");
  }
});

test("the real root keeps exact plain bytes for rejected HTML and varies both representations on Accept", async () => {
  for (const accept of [...rejected, ...accepted]) {
    const response = await worker.fetch(new Request(ORIGIN, { headers: { Accept: accept } }), {} as never);
    const html = accepted.includes(accept);
    assert.equal(response.status, 200, accept);
    assert.equal(response.headers.get("Content-Type"), `${html ? "text/html" : "text/plain"}; charset=utf-8`, accept);
    assert.equal(response.headers.get("Vary"), "Accept", accept);
    const body = await response.text();
    if (html) assert.ok(body.startsWith("<!doctype html>"), accept);
    else assert.equal(body, frontDoor(ORIGIN), accept);
  }
});

test("the source index, directory, and file respect the same HTML rejection and raw override", async () => {
  const source = "export const value = 1;\n";
  const env = { ASSETS: fakeAssets({ "src/example.ts": source }), BUILD_COMMIT: MIRROR_COMMIT };
  for (const rest of [null, "1f916", "1f916/src/example.ts"]) {
    const path = rest === null ? "/source" : `/source/${rest}`;
    const call = (accept: string, raw = false) => serveSource(env, new Request(`${ORIGIN}${path}${raw ? "?raw=1" : ""}`, { headers: { Accept: accept } }), rest);
    const plainBody = await (await call("text/plain")).text();
    for (const accept of ["text/html;q=0, text/plain;q=1", 'text/html;foo="x;q=0;y";q=1']) {
      const response = await call(accept);
      const html = !accept.startsWith("text/html;q=0");
      assert.equal(response.headers.get("Content-Type"), `${html ? "text/html" : "text/plain"}; charset=utf-8`, `${path} ${accept}`);
      assert.equal(response.headers.get("Vary"), "Accept");
      if (!html) assert.equal(await response.text(), plainBody);
    }
    const raw = await call("text/html;q=0.8", true);
    assert.equal(raw.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(await raw.text(), plainBody);
    if (rest === "1f916/src/example.ts") assert.equal(plainBody, source);
  }
});
