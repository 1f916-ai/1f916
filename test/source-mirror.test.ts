// GET /source: the deployment serves its own source (src/source-mirror.ts).
//
// Run: npm test
//
// Each guarantee below names the mutation that turns it red.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { serveSource } from "../src/source-mirror.ts";
import { fakeAssets, MIRROR_COMMIT, PROTOCOL_COMMIT } from "./helpers/fake-assets.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://1f916.ai";
const HTML = "text/html";

const TREE = {
  "README.md": "# hello\n",
  "src/index.ts": "export const a = 1;\nexport const b = '</code><script>alert(1)</script>';\n",
  "src/page.html": "<script>document.cookie</script>",
  "img/logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
  "img/robot.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  "vendor/protocol/verify.mjs": "// checker\n",
  "vendor/protocol.commit": `${PROTOCOL_COMMIT}\n`,
};

function call(path: string, accept?: string, assets = fakeAssets(TREE), buildCommit: string | undefined = MIRROR_COMMIT) {
  const rest = path === "/source" ? null : path.replace(/^\/source\//, "");
  const req = new Request(`${ORIGIN}${path}`, accept ? { headers: { Accept: accept } } : undefined);
  return serveSource({ ASSETS: assets, BUILD_COMMIT: buildCommit }, req, rest);
}

// Mutation: serve raw files with the asset store's guessed type (pass
// asset.headers through). An .html or .svg file from the repository would
// then run script on this origin.
test("a raw file is text/plain, nosniff and sandboxed, whatever its extension", async () => {
  for (const path of ["/source/1f916/src/page.html", "/source/1f916/img/logo.svg", "/source/1f916/src/index.ts"]) {
    const r = await call(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get("Content-Type"), "text/plain; charset=utf-8", path);
    assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff", path);
    assert.match(r.headers.get("Content-Security-Policy") ?? "", /sandbox/, path);
  }
  const html = await call("/source/1f916/src/page.html?raw=1", HTML);
  assert.equal(html.headers.get("Content-Type"), "text/plain; charset=utf-8", "?raw=1 wins over a browser Accept");
});

// Mutation: drop Vary from headers(). The same URL negotiates HTML or the
// file and is publicly cacheable, so an edge cache would cross the two.
test("every negotiated response varies on Accept", async () => {
  for (const [path, accept] of [["/source", undefined], ["/source", HTML], ["/source/1f916", HTML], ["/source/protocol/verify.mjs", undefined], ["/source/protocol/verify.mjs", HTML]] as const) {
    assert.equal((await call(path, accept)).headers.get("Vary"), "Accept", `${path} ${accept ?? "*/*"}`);
  }
});

// Mutation: drop RASTER.png. A PNG would be served as text.
test("raster images keep their image type", async () => {
  const r = await call("/source/1f916/img/robot.png");
  assert.equal(r.headers.get("Content-Type"), "image/png");
});

// Mutation: drop esc() from the line renderer, or loosen VIEW_CSP to allow script.
test("the HTML view escapes the file and allows no script", async () => {
  const r = await call("/source/1f916/src/index.ts", HTML);
  const body = await r.text();
  assert.equal(r.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.ok(!body.includes("<script>alert(1)</script>"), "file content reached the page unescaped");
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const csp = r.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.ok(body.includes('<span id="L2"><a href="#L2">2</a>'), "lines carry #L anchors");
});

// Mutation: look the path up in the asset store instead of the manifest. The
// store holds manifest.json and the tarballs too; only listed files are the tree.
test("only a path the manifest lists is ever fetched", async () => {
  const assets = fakeAssets({ ...TREE, "unlisted.txt": "should not be served" }, {}, Object.keys(TREE));
  for (const path of ["/source/1f916/unlisted.txt", "/source/1f916/%2e%2e/manifest.json", "/source/1f916/..%2Fmanifest.json"]) {
    const r = await call(path, undefined, assets);
    assert.equal(r.status, 404, path);
  }
  assert.deepEqual(assets.asked.filter((p) => p !== "manifest.json"), [], "the route fetched something the manifest does not list");
});

// Mutation: drop the @commit comparison. An old commit's URL would then serve
// the current bytes under a name that promised different ones.
test("a URL naming a commit answers only while that commit is running", async () => {
  assert.equal((await call(`/source/1f916@${MIRROR_COMMIT}/README.md`)).status, 200);
  assert.equal((await call(`/source/1f916@${MIRROR_COMMIT.slice(0, 7)}/README.md`)).status, 200);
  const old = await call(`/source/1f916@${"c".repeat(40)}/README.md`);
  assert.equal(old.status, 404);
  assert.match(await old.text(), new RegExp(MIRROR_COMMIT));
  assert.equal((await call(`/source/protocol@${PROTOCOL_COMMIT}/verify.mjs`)).status, 200, "protocol is checked against its own commit");
  assert.equal((await call(`/source/protocol@${MIRROR_COMMIT}/verify.mjs`)).status, 404);
});

// Mutation: change the protocol prefix. The record pages tell readers to run
// /source/protocol/verify.mjs; it must be the vendored file.
test("the protocol tree is vendor/protocol", async () => {
  const assets = fakeAssets(TREE);
  const r = await call("/source/protocol/verify.mjs", undefined, assets);
  assert.equal(await r.text(), "// checker\n");
  assert.ok(assets.asked.includes("tree/vendor/protocol/verify.mjs"));
  const listing = await (await call("/source/protocol")).text();
  assert.equal(listing, "verify.mjs\t11");
});

test("a directory lists its immediate children, directories first", async () => {
  const r = await call("/source/1f916");
  assert.equal(await r.text(), ["img/", "src/", "vendor/", "README.md\t8"].join("\n"));
  assert.equal((await call("/source/1f916/nope")).status, 404);
  assert.equal((await call("/source/elsewhere/README.md")).status, 404);
});

// Mutation: drop buildNote's mismatch branch. A mirror built from one commit
// would then present itself as the code a different deploy is running.
test("the index says when the mirror and the deployment disagree", async () => {
  const same = await (await call("/source")).text();
  assert.match(same, /This is the commit the deployment names as code\.commit/);
  assert.match(same, new RegExp(`1f916     commit   ${MIRROR_COMMIT}`));
  assert.match(same, new RegExp(`protocol  commit   ${PROTOCOL_COMMIT}`));
  const other = await (await call("/source", undefined, fakeAssets(TREE), "d".repeat(40))).text();
  assert.match(other, /WARNING: this tree was built from a{40} but the deployment names d{40}/);
  const none = await (await serveSource({ ASSETS: fakeAssets(TREE) }, new Request(`${ORIGIN}/source`), null)).text();
  assert.match(none, /does not name its commit/);
});

test("tarballs download as attachments named for their commit", async () => {
  const assets = fakeAssets(TREE, { "1f916.tar.gz": "gz", "protocol.tar.gz": "pgz" });
  const r = await call("/source/1f916.tar.gz", undefined, assets);
  assert.equal(r.headers.get("Content-Type"), "application/gzip");
  assert.equal(r.headers.get("Content-Disposition"), `attachment; filename="1f916-${MIRROR_COMMIT.slice(0, 12)}.tar.gz"`);
  const p = await call("/source/protocol.tar.gz", undefined, assets);
  assert.equal(await p.text(), "pgz");
});

test("no ASSETS binding is a 503 that says why, not a 404", async () => {
  const r = await serveSource({}, new Request(`${ORIGIN}/source`), null);
  assert.equal(r.status, 503);
  assert.match(await r.text(), /no source mirror/);
});

// Mutation: delete either route in src/index.ts.
test("the router dispatches /source and /source/<path>", async () => {
  const env = { ASSETS: fakeAssets(TREE), BUILD_COMMIT: MIRROR_COMMIT } as unknown as Env;
  const index = await worker.fetch(new Request(`${ORIGIN}/source/`), env);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /^SOURCE/);
  const file = await worker.fetch(new Request(`${ORIGIN}/source/1f916/README.md`), env);
  assert.equal(await file.text(), "# hello\n");
  const head = await worker.fetch(new Request(`${ORIGIN}/source/1f916/README.md`, { method: "HEAD" }), env);
  assert.equal(head.status, 200);
});
