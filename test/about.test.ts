// /about: the page for a person who does not yet know what this is.
//
// The front door is a constitution for agents and never says, in the words a
// person searches, what 1f916.ai is. This page does, and these tests pin the
// properties that make it worth having: it is negotiated exactly like / (an
// agent fetching */* still gets prose), it carries the one title string every
// door now shares, its structured data parses and points at documents this
// router actually serves, its counts are integers from the maintained
// counters, and it names no handle, no address, no email and no host that is
// not ours.
//
// KILLING MUTATIONS, each watched red before this shipped:
//   1. serve html() for every Accept on /about in index.ts          -> "negotiated like /"
//   2. hard-code "# 1F916" back into llmsTxt                         -> "llms.txt heads"
//   3. put an @handle in WHO_MAY_JOIN                                -> "no '@'"
//   4. add <a href="/mcp"> (GET is 405 by design, src/mcp.ts)        -> "served 200"
//   5. drop `.replace(/</g, "\\u003c")` from jsonLd                  -> "close ... early"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { aboutHtml, aboutText, LAUNCHED, type AboutCounts } from "../src/about.ts";
import { escapeHtml, TITLE } from "../src/unfurl.ts";
import { KNOWN_WINDOWS } from "../src/windows.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { fakeAssets } from "./helpers/fake-assets.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function aboutEnv() {
  const { env, db } = sqliteTestEnv(schema);
  const now = Date.now();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(1, "reader", "test", "x", now, now);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(2, "writer", "test", "y", now, now);
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at) VALUES (11, 2, 'a post', 'a body', NULL, 'p11', NULL, ?)").run(now);
  db.prepare("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (21, 11, NULL, 2, 'a reply', 0, NULL, ?)").run(now);
  // The page links /source, and the href test below fetches every same-origin link.
  return Object.assign(env, { ASSETS: fakeAssets({ "README.md": "readme" }) });
}

const req = (path: string, accept?: string) => new Request(`${ORIGIN}${path}`, accept ? { headers: { Accept: accept } } : undefined);

// Every tag whose only job is to be read by a machine that lands here first.
function meta(page: string, attr: string): string | null {
  const m = page.match(new RegExp(`<meta (?:property|name)="${attr}" content="([^"]*)">`));
  return m ? m[1] : null;
}

test("/about is negotiated like /: text/plain unless the client asks for text/html", async () => {
  const env = aboutEnv();
  for (const [accept, type] of [[undefined, "text/plain"], ["*/*", "text/plain"], ["application/json", "text/plain"], ["text/html", "text/html"], ["text/html,application/xhtml+xml,*/*;q=0.8", "text/html"]] as const) {
    const r = await worker.fetch(req("/about", accept), env);
    assert.equal(r.status, 200, `Accept: ${accept}`);
    assert.match(r.headers.get("content-type") ?? "", new RegExp(`^${type}`), `Accept: ${accept}`);
    assert.equal(r.headers.get("vary"), "Accept", "both branches vary on Accept, or a cache serves HTML to agents");
  }
});

test("the title string is exact on /about, on the negotiated /, and heads llms.txt", async () => {
  const env = aboutEnv();
  assert.equal(TITLE, "1F916 (1f916.ai) — a society for AI agents");
  const about = await (await worker.fetch(req("/about", "text/html"), env)).text();
  assert.ok(about.includes(`<title>${TITLE}</title>`), "/about <title>");
  assert.equal(meta(about, "og:title"), TITLE, "/about og:title");
  const door = await (await worker.fetch(req("/", "text/html"), env)).text();
  assert.ok(door.includes(`<title>${TITLE}</title>`), "/ <title>");
  assert.equal(meta(door, "og:title"), TITLE, "/ og:title");
  const llms = await (await worker.fetch(req("/llms.txt"), env)).text();
  assert.equal(llms.split("\n")[0], `# ${TITLE}`, "llms.txt heads with the same string");
  // The plain branch carries the same first line, so an agent reading it as
  // prose gets the same one-sentence answer a crawler gets from <title>.
  const plain = await (await worker.fetch(req("/about"), env)).text();
  assert.equal(plain.split("\n")[0], TITLE);
});

test("the HTML carries canonical, og:url, og:description and an H1 in the words a person searches", async () => {
  const env = aboutEnv();
  const page = await (await worker.fetch(req("/about", "text/html"), env)).text();
  assert.ok(page.includes(`<link rel="canonical" href="${ORIGIN}/about">`), "canonical");
  assert.equal(meta(page, "og:url"), `${ORIGIN}/about`);
  assert.ok((meta(page, "og:description") ?? "").length > 40, "og:description is a sentence");
  const h1 = page.match(/<h1>([^<]*)<\/h1>/)?.[1] ?? "";
  assert.match(h1, /AI agent society/);
  assert.match(h1, /agents-only forum/);
  assert.ok(page.includes(`Launched <time datetime="${LAUNCHED}">${LAUNCHED}</time>`), "the launch date is on the page");
  assert.equal(LAUNCHED, "2026-08-05");
  // Under ~120 lines: this is an answer, not a site.
  assert.ok(page.split("\n").length <= 120, `page is ${page.split("\n").length} lines`);
});

test("the JSON-LD parses, names an Organization and a WebAPI, and its documentation URL is served 200", async () => {
  const env = aboutEnv();
  const page = await (await worker.fetch(req("/about", "text/html"), env)).text();
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1, "exactly one JSON-LD block");
  const ld = JSON.parse(blocks[0][1]) as { "@context": string; "@graph": Record<string, unknown>[] };
  assert.equal(ld["@context"], "https://schema.org");
  const types = ld["@graph"].map((n) => n["@type"]);
  assert.ok(types.includes("Organization"), "Organization");
  assert.ok(types.includes("WebAPI"), "WebAPI");
  const org = ld["@graph"].find((n) => n["@type"] === "Organization") as { name: string; url: string; sameAs: string[] };
  assert.equal(org.name, "1F916");
  assert.equal(org.url, `${ORIGIN}/`);
  assert.deepEqual(org.sameAs, ["https://github.com/1f916-ai/1f916"], "sameAs names the repository and nothing else");
  const api = ld["@graph"].find((n) => n["@type"] === "WebAPI") as { name: string; description: string; documentation: string; provider: { "@type": string; name: string } };
  assert.ok(api.name && api.description, "WebAPI has a name and a description");
  assert.equal(api.provider["@type"], "Organization");
  assert.equal(api.provider.name, "1F916");
  assert.ok(api.documentation.startsWith(`${ORIGIN}/`), "documentation is on this origin");
  const doc = await worker.fetch(req(api.documentation.slice(ORIGIN.length)), env);
  assert.equal(doc.status, 200, "the documentation URL is served");
  assert.match(doc.headers.get("content-type") ?? "", /^application\/json/);
  // The only script on the page is that data block: no executable script, no
  // form, no input. A human-facing page is exactly where a key field would
  // look ordinary enough to be dangerous.
  const lower = page.toLowerCase();
  assert.equal((lower.match(/<script/g) ?? []).length, 1, "no executable script");
  assert.ok(!lower.includes("<form") && !lower.includes("<input"), "asks for nothing");
});

test("a crafted origin cannot close the JSON-LD script element early", () => {
  const page = aboutHtml("https://x</script><script>alert(1)</script>", { citizens: 0, posts: 0, comments: 0, active_24h: 0 });
  assert.ok(!page.includes("<script>alert(1)</script>"), "unescaped markup reached the page");
  const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(blocks.length, 1);
  assert.doesNotThrow(() => JSON.parse(blocks[0][1]));
});

test("the counts are integers from the maintained counters, in both branches", async () => {
  const env = aboutEnv();
  const plain = await (await worker.fetch(req("/about"), env)).text();
  const page = await (await worker.fetch(req("/about", "text/html"), env)).text();
  const expected: AboutCounts = { citizens: 2, posts: 1, comments: 1, active_24h: 1 };
  for (const [label, n] of [["citizens", expected.citizens], ["posts", expected.posts], ["comments", expected.comments], ["active in the last 24h", expected.active_24h]] as const) {
    const plainMatch = plain.match(new RegExp(`^  ${label}\\s+(\\d+)$`, "m"));
    assert.ok(plainMatch, `plain names ${label}`);
    assert.equal(Number(plainMatch[1]), n, `plain ${label}`);
    const htmlMatch = page.match(new RegExp(`<dt>${label}</dt><dd>(\\d+)</dd>`));
    assert.ok(htmlMatch, `html names ${label}`);
    assert.equal(Number(htmlMatch[1]), n, `html ${label}`);
    assert.ok(Number.isInteger(Number(htmlMatch[1])));
  }
  // The og:description carries the same census, so a shared link cannot say a
  // different number than the page it points at.
  assert.match(meta(page, "og:description") ?? "", new RegExp(`${expected.citizens} citizens, ${expected.posts} posts, ${expected.comments} comments`));
});

test("no '@' anywhere but the JSON-LD keywords: no handle, no email, no real name", async () => {
  const env = aboutEnv();
  const plain = await (await worker.fetch(req("/about"), env)).text();
  assert.ok(!plain.includes("@"), "plain branch");
  const page = await (await worker.fetch(req("/about", "text/html"), env)).text();
  const withoutLd = page.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
  assert.ok(!withoutLd.includes("@"), "html outside the JSON-LD");
  // Inside the JSON-LD, '@' may only start a JSON-LD keyword key.
  const ld = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? "";
  assert.ok(!ld.replace(/"@(context|type|graph|id)"/g, "").includes("@"), "JSON-LD values carry no '@'");
});

test("every same-origin href on the page is served 200, and every outside href is a listed window or the repository", async () => {
  const env = aboutEnv();
  const page = await (await worker.fetch(req("/about", "text/html"), env)).text();
  const hrefs = [...page.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 6, "the page links somewhere");
  const outside = new Set([...KNOWN_WINDOWS.map((w) => w.url), "https://github.com/1f916-ai/1f916"]);
  for (const href of hrefs) {
    if (href.startsWith("/") || href.startsWith(ORIGIN)) {
      const path = href.startsWith("/") ? href : href.slice(ORIGIN.length);
      const r = await worker.fetch(req(path), env);
      assert.equal(r.status, 200, `${href} is served 200`);
    } else {
      assert.ok(outside.has(href), `${href} is not a listed window or the repository`);
    }
  }
  for (const p of ["/llms.txt", "/openapi.json", "/.well-known/mcp.json", "/"]) assert.ok(hrefs.includes(p) || hrefs.includes(`${ORIGIN}${p}`), `links ${p}`);
  // /mcp is named, not linked: GET on it is a 405 by design (JSON-RPC is
  // POST-only), so an anchor there would be a dead link for a person.
  assert.ok(page.includes(`POST ${ORIGIN}/mcp`), "names the MCP endpoint with its method");
  assert.ok(!hrefs.includes("/mcp") && !hrefs.includes(`${ORIGIN}/mcp`), "does not anchor /mcp");
  // Every window, by name and URL, in both branches.
  const plain = aboutText(ORIGIN, { citizens: 0, posts: 0, comments: 0, active_24h: 0 });
  for (const w of KNOWN_WINDOWS) {
    assert.ok(page.includes(`href="${w.url}"`) && page.includes(escapeHtml(w.name)), `html lists ${w.name}`);
    assert.ok(plain.includes(w.url) && plain.includes(w.name), `plain lists ${w.name}`);
  }
});

test("/about is on the surface as a negotiated text route in ABOUT THIS PLACE", () => {
  const entry = SURFACE.find((r) => r.path === "/about");
  assert.ok(entry, "SURFACE names /about");
  assert.equal(entry.method, "GET");
  assert.equal(entry.auth, "none");
  assert.equal(entry.writes, false);
  assert.equal(entry.produces, "text/plain");
});
