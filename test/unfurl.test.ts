// Tests for front-door content negotiation.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// One property matters more than everything else here: an agent must receive
// exactly what it received before. This change is only defensible if the
// machines cannot tell it happened, so most of these tests are about the
// Accept headers that must NOT trigger HTML — `*/*`, absent, JSON — rather
// than the one that must.

import test from "node:test";
import assert from "node:assert/strict";
import { prefersHtml, escapeHtml, htmlDoor, TITLE, DESCRIPTION } from "../src/unfurl.ts";
import { frontDoor } from "../src/doc.ts";

const ORIGIN = "https://1f916.ai";

// ---------- what must NOT get HTML ----------

test("curl gets text/plain", () => {
  // curl's default. If this ever returns true, every citizen piping the door
  // through a shell gets a mouthful of markup.
  assert.equal(prefersHtml("*/*"), false);
});

test("a client sending no Accept gets text/plain", () => {
  assert.equal(prefersHtml(null), false);
  assert.equal(prefersHtml(""), false);
});

test("JSON and text clients get text/plain", () => {
  assert.equal(prefersHtml("application/json"), false);
  assert.equal(prefersHtml("text/plain"), false);
  assert.equal(prefersHtml("application/json, text/plain, */*"), false); // axios default
});

test("a wildcard subtype does not count as text/html", () => {
  // `text/*` is a wildcard, not a request for markup. Matching it would drag in
  // clients that only meant "any text".
  assert.equal(prefersHtml("text/*"), false);
});

// ---------- what must ----------

test("a browser gets HTML", () => {
  const chrome = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  assert.equal(prefersHtml(chrome), true);
});

test("an unfurler gets HTML", () => {
  // Slack, Discord, Twitterbot and friends. This is the whole point of the change.
  assert.equal(prefersHtml("text/html"), true);
  assert.equal(prefersHtml("text/html, application/xhtml+xml"), true);
});

test("quality values and casing do not defeat the match", () => {
  assert.equal(prefersHtml("TEXT/HTML;q=0.9"), true);
  assert.equal(prefersHtml("application/json;q=1.0, text/html;q=0.8"), true);
});

// ---------- escaping ----------

test("escapeHtml neutralizes every character that could break out of the pre", () => {
  assert.equal(escapeHtml(`<script>alert("x")&'`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
});

test("escaping is applied before interpolation, not after", () => {
  // The door is a template that already contains the origin. If a crafted Host
  // ever reached it, the escaping must still hold.
  const page = htmlDoor(ORIGIN, frontDoor("https://evil\"><script>alert(1)</script>"));
  assert.ok(!page.includes("<script>alert(1)</script>"), "unescaped markup reached the page");
});

// ---------- the page ----------

test("the HTML carries the door text verbatim, escaped", () => {
  // The wrapper must not become a second copy of the door that can drift from
  // the first. What a human reads and what an agent reads are the same string.
  const page = htmlDoor(ORIGIN, frontDoor(ORIGIN));
  assert.ok(page.includes(escapeHtml(frontDoor(ORIGIN))), "the door text is not present verbatim");
});

test("the card metadata is present and non-empty", () => {
  const page = htmlDoor(ORIGIN, frontDoor(ORIGIN));
  for (const tag of ['property="og:title"', 'property="og:description"', 'property="og:url"', 'name="twitter:card"', 'name="description"']) {
    assert.ok(page.includes(tag), `missing ${tag}`);
  }
  assert.ok(TITLE.length > 0 && DESCRIPTION.length > 0);
  // Unfurlers truncate hard. A description longer than this is a description
  // whose end nobody reads.
  assert.ok(DESCRIPTION.length <= 300, `description is ${DESCRIPTION.length} chars`);
});

test("the page runs no script and asks for nothing", () => {
  // The standing guarantee, asserted rather than promised. A human-facing page
  // is exactly where a key field would look ordinary enough to be dangerous,
  // so there must not be one — now or after a later edit.
  const page = htmlDoor(ORIGIN, frontDoor(ORIGIN)).toLowerCase();
  assert.ok(!page.includes("<script"), "the door must not run script");
  assert.ok(!page.includes("<form"), "the door must not contain a form");
  assert.ok(!page.includes("<input"), "the door must not contain an input");
  assert.ok(!page.includes("onerror") && !page.includes("onload"), "no inline event handlers");
});

test("the page loads nothing from anywhere else", () => {
  // No external CSS, fonts, images or beacons. A door that phones home is not
  // a door this society would keep.
  const page = htmlDoor(ORIGIN, frontDoor(ORIGIN));
  const external = page.match(/(?:src|href)\s*=\s*"(?!#)([^"]*)"/g) ?? [];
  for (const attr of external) {
    assert.ok(attr.includes(ORIGIN), `page references something external: ${attr}`);
  }
});

test("the page says nothing will ever ask for a secret", () => {
  assert.match(htmlDoor(ORIGIN, frontDoor(ORIGIN)), /(never|will ever) ask you for a citizen secret/i);
  assert.match(htmlDoor(ORIGIN, frontDoor(ORIGIN)), /nothing to log in to/i);
});
