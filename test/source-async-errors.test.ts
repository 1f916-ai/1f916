// The source mirror is async: rejected assets must reach the router's catch,
// just like the delegated MCP handler (issue #42), not reject Worker.fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import type { AssetFetcher } from "../src/source-mirror.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { fakeAssets, MIRROR_COMMIT } from "./helpers/fake-assets.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const tree = { "README.md": "# source — 🤖\n" };
const failure = "fixture asset failure";

function fixture(assets?: AssetFetcher) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("PRAGMA query_only = ON");
  const baseline = db.prepare("SELECT total_changes() AS n").get();
  let storageCalls = 0;
  const guarded = new Proxy(env.DB, {
    get() {
      storageCalls++;
      throw new Error("source requests must not access storage");
    },
  });
  return {
    env: { ...env, DB: guarded, ASSETS: assets, BUILD_COMMIT: MIRROR_COMMIT },
    close() {
      assert.equal(storageCalls, 0);
      assert.deepEqual(db.prepare("SELECT total_changes() AS n").get(), baseline);
      db.close();
    },
  };
}

function request(path: string, method = "GET", accept = "text/plain") {
  return new Request(`${ORIGIN}${path}`, { method, headers: { Accept: accept } });
}

async function expectInternalError(env: ReturnType<typeof fixture>["env"], path: string, method = "GET", accept = "text/plain") {
  const response = await worker.fetch(request(path, method, accept), env);
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  if (method === "HEAD") {
    assert.equal(await response.text(), "");
    assert.ok(Number(response.headers.get("Content-Length")) > 0);
  } else {
    const data = await response.json();
    assert.equal(data.error, "Internal error. The society apologizes.");
    assert.equal(typeof data.now, "number");
    assert.equal(data.now_utc, new Date(data.now).toISOString());
    assert.ok(!JSON.stringify(data).includes(failure));
  }
}

test("source index and child routes contain rejected manifest fetches, including HEAD and trailing slashes", async () => {
  for (const path of ["/source", "/source/", "/source/1f916/README.md", "/source/1f916/README.md/"]) {
    for (const method of ["GET", "HEAD"]) {
      let fetches = 0;
      const f = fixture({ fetch: async () => { fetches++; throw new Error(failure); } });
      try {
        await expectInternalError(f.env, path, method);
        assert.equal(fetches, 1);
      } finally { f.close(); }
    }
  }
});

test("a manifest decode failure reaches the same controlled source error response", async () => {
  for (const path of ["/source", "/source/1f916"]) {
    const f = fixture({ fetch: async () => { return new Response("not JSON"); } });
    try { await expectInternalError(f.env, path); } finally { f.close(); }
  }
});

test("source file and tarball asset-fetch failures are contained after the manifest loads", async () => {
  for (const [path, accept] of [["/source/1f916/README.md", "text/plain"], ["/source/1f916/README.md", "text/html"], ["/source/1f916.tar.gz", "text/plain"]]) {
    const assets = fakeAssets(tree);
    const asked: string[] = [];
    const f = fixture({ fetch: async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      asked.push(url.pathname);
      if (url.pathname !== "/manifest.json") throw new Error(failure);
      return assets.fetch(input);
    } });
    try {
      await expectInternalError(f.env, path, "GET", accept);
      assert.deepEqual(asked, ["/manifest.json", path.endsWith("tar.gz") ? "/1f916.tar.gz" : "/tree/README.md"]);
    } finally { f.close(); }
  }
});

test("source text body-read failures are contained in both raw and rendered views", async () => {
  for (const accept of ["text/plain", "text/html"]) {
    const assets = fakeAssets(tree);
    let reads = 0;
    const f = fixture({ fetch: async (input) => {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (url.pathname === "/manifest.json") return assets.fetch(input);
      reads++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(failure)); } }));
    } });
    try {
      await expectInternalError(f.env, "/source/1f916/README.md", "GET", accept);
      assert.equal(reads, 1);
    } finally { f.close(); }
  }
});

test("an asset outage does not poison the source manifest cache or change recovered bytes", async () => {
  const assets = fakeAssets(tree);
  let attempts = 0;
  const f = fixture({ fetch: async (input) => {
    attempts++;
    if (attempts === 1) throw new Error(failure);
    return assets.fetch(input);
  } });
  try {
    await expectInternalError(f.env, "/source");
    const recovered = await worker.fetch(request("/source/1f916/README.md"), f.env);
    assert.equal(recovered.status, 200);
    assert.equal(await recovered.text(), tree["README.md"]);
    assert.equal(attempts, 3);
  } finally { f.close(); }
});

test("source success and explicit unavailable/missing responses keep their existing representations", async () => {
  const f = fixture(fakeAssets(tree));
  const absent = fixture();
  const empty = fixture({ fetch: async () => { return new Response("not found", { status: 404 }); } });
  try {
    const plain = await worker.fetch(request("/source/1f916/README.md"), f.env);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(plain.headers.get("Vary"), "Accept");
    assert.equal(await plain.text(), tree["README.md"]);
    const html = await worker.fetch(request("/source/1f916/README.md", "GET", "text/html"), f.env);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.ok((await html.text()).includes('<span id="L1"><a href="#L1">1</a># source — 🤖</span>'));
    const head = await worker.fetch(request("/source/1f916/README.md", "HEAD"), f.env);
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("Content-Length"), String(new TextEncoder().encode(tree["README.md"]).length));
    for (const env of [absent.env, empty.env]) {
      const unavailable = await worker.fetch(request("/source"), env);
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.headers.get("Content-Type"), "text/plain; charset=utf-8");
      assert.match(await unavailable.text(), /no source mirror/);
    }
    for (const path of ["/source/1f916/missing.txt", `/source/1f916@${"c".repeat(40)}/README.md`]) {
      const missing = await worker.fetch(request(path), f.env);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("Content-Type"), "text/plain; charset=utf-8");
    }
    const missingTarball = await worker.fetch(request("/source/1f916.tar.gz"), f.env);
    assert.equal(missingTarball.status, 503);
    assert.match(await missingTarball.text(), /missing from this build/);
  } finally { f.close(); absent.close(); empty.close(); }
});
