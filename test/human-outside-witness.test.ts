// GET /human/outside-witness: use 1F916 as the outside witness for a log you
// keep yourself (src/human-outside-witness.ts), and the adapter it names
// (clients/witness-log.mjs).
//
// The page tells an operator what line to seal and what a reader checks. A
// line the adapter does not build, a command it does not have, a figure the
// handler does not enforce, or an example that is not a seal would each send
// the one reader who tries it to a dead end.
//
// Killing mutations (each verified red in a scratch copy, 2026-10-06):
//   W1  delete the /human/outside-witness route               -> "the page is served as HTML"
//   W2  change the prefix on the page or in the adapter, not both -> "the line on the page is the line the adapter builds"
//   W3  rename a command on the page                           -> "the commands are the adapter's own"
//   W4  write a budget by hand                                 -> "the figures are the ones the seal door enforces"
//   W5  alter the example's count or head                      -> "the worked example is the adapter's line for a seal that exists"
//   W6  let the adapter send check_only on a seal              -> "seal and check send what the door expects, and only that"
//   W7  let the adapter accept a head that is not sha-256      -> "the adapter refuses a piece that cannot be part of the line"
//   W8  link an outside site                                   -> "the page names no site but this one"
//   W9  (2026-10-06, auditor) let the adapter seal a reserved name, or round a count through Number() -> "the adapter refuses the names the door reserves, and seals the digits it was given"
//   W10 exit 0 on any 2xx, or on a 201 whose hash is not the line's    -> "the command exits 0 only on a seal or a check of the line"
//   W11 send the line through a fake door only                          -> "one round trip through the real door"
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { sha256Hex } from "../src/chain.ts";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  HUMAN_OUTSIDE_WITNESS_HTML,
  OW_CHECK_COMMAND,
  OW_CONTACT,
  OW_EVIDENCE_PATH,
  OW_EXAMPLE,
  OW_EXAMPLE_LINE,
  OW_EXAMPLE_SEALS_PATH,
  OW_LINE,
  OW_LINE_PREFIX,
  OW_ORIGIN,
  OW_REGISTER_COMMAND,
  OW_SCRIPT_PATH,
  OW_SCRIPT_REPO_PATH,
  OW_SEAL_COMMAND,
} from "../src/human-outside-witness.ts";
import { LABEL_MAX, SEALS_PER_DAY, SEAL_CHECKS_PER_DAY } from "../src/seals.ts";
import { SURFACE } from "../src/surface.ts";
import * as adapter from "../clients/witness-log.mjs";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const repo = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const get = (env: unknown, path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(OW_ORIGIN + path, { headers }), env as never);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const text = HUMAN_OUTSIDE_WITNESS_HTML.replace(/<style>.*?<\/style>/s, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&amp;/g, "&");
const HEAD = "6fca8ed862175229a31bbdb6c407c8ad3e642666fd254fd1ba03b09c820a0d22";

test("the page is served as HTML", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await get(env, "/human/outside-witness", { Accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type") ?? "", /^text\/html/);
  assert.equal(await res.text(), HUMAN_OUTSIDE_WITNESS_HTML);
  assert.match(HUMAN_OUTSIDE_WITNESS_HTML, /<title>Be witnessed · 1F916<\/title>/);
  assert.ok(SURFACE.some((r) => r.path === "/human/outside-witness" && r.method === "GET"));
});

test("the line on the page is the line the adapter builds", () => {
  assert.equal(adapter.WITNESS_LINE_PREFIX, OW_LINE_PREFIX);
  assert.equal(OW_LINE, `${OW_LINE_PREFIX} log=<name> count=<entries> head=<hex>`);
  assert.equal(adapter.witnessLine("my-log", 12, HEAD), `1f916.outside-witness.v1 log=my-log count=12 head=${HEAD}`);
  assert.equal(adapter.witnessLine("my-log", "12", HEAD), adapter.witnessLine("my-log", 12, HEAD));
  assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${esc(OW_LINE)}</pre>`));
});

test("the adapter refuses a piece that cannot be part of the line", () => {
  for (const [log, count, head] of [["My-Log", 1, HEAD], ["a:b", 1, HEAD], ["x".repeat(LABEL_MAX + 1), 1, HEAD], ["ok", -1, HEAD], ["ok", 1.5, HEAD], ["ok", "1 ", HEAD], ["ok", 1, HEAD.toUpperCase()], ["ok", 1, HEAD.slice(1)], ["ok", 1, `${HEAD} count=9`]] as const) {
    assert.throws(() => adapter.witnessLine(log as string, count as number, head as string), /must/, `${log} ${count} ${head}`);
  }
  assert.equal(adapter.witnessLine("x".repeat(LABEL_MAX), 0, HEAD).startsWith(OW_LINE_PREFIX), true);
  assert.throws(() => adapter.witnessLine("ok", 2 ** 60, HEAD), /above 2\^53 as a string/);
});

test("seal and check send what the door expects, and only that", async () => {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ sealed: true, id: 42, hash: createHash("sha256").update(String(JSON.parse(init.body as string).text)).digest("hex") }), { status: 201 });
  };
  const sealed = await adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl });
  assert.equal(sealed.status, 201);
  assert.equal(sealed.id, 42);
  assert.equal(sealed.line, adapter.witnessLine("my-log", 12, HEAD));
  assert.equal(sent[0].url, "https://registry.test/api/seal");
  assert.equal(sent[0].init.method, "POST");
  assert.equal((sent[0].init.headers as Record<string, string>).Authorization, "Bearer s3cret");
  assert.deepEqual(JSON.parse(sent[0].init.body as string), { text: sealed.line, label: "my-log" });
  await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl });
  assert.deepEqual(JSON.parse(sent[1].init.body as string), { text: sealed.line, label: "my-log", check_only: true });
  await assert.rejects(adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret: "", fetchImpl }), /F916_SECRET is not set/);
  await assert.rejects(adapter.witness({ action: "delete", log: "my-log", count: 12, head: HEAD, secret: "s", fetchImpl } as never), /seal or check/);
  // A refusal comes back with its status and the door's words, not as a throw.
  const refused = await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret: "s3cret", origin: "https://registry.test", fetchImpl: async () => new Response(JSON.stringify({ error: "check_only: this is NOT what you last sealed" }), { status: 409 }) });
  assert.equal(refused.status, 409);
  assert.match(refused.error, /NOT what you last sealed/);
});

test("the commands are the adapter's own", () => {
  const source = readFileSync(repo(OW_SCRIPT_REPO_PATH), "utf8");
  assert.ok(source.includes("node witness-log.mjs seal  --log <name> --count <n> --head <hex>"));
  assert.ok(source.includes("node witness-log.mjs check --log <name> --count <n> --head <hex>"));
  assert.ok(source.includes("F916_SECRET"));
  assert.equal(OW_SEAL_COMMAND, "F916_SECRET=... node witness-log.mjs seal --log <name> --count <entries> --head <hex>");
  assert.equal(OW_CHECK_COMMAND, "F916_SECRET=... node witness-log.mjs check --log <name> --count <entries> --head <hex>");
  for (const cmd of [OW_REGISTER_COMMAND, OW_SEAL_COMMAND, OW_CHECK_COMMAND]) assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${esc(cmd)}</pre>`), cmd);
  assert.ok(OW_REGISTER_COMMAND.includes(`${OW_ORIGIN}/api/register`));
  assert.ok(SURFACE.some((r) => r.path === "/api/register" && r.method === "POST"));
  assert.ok(SURFACE.some((r) => r.path === "/api/seal" && r.method === "POST"));
});

test("the figures are the ones the seal door enforces", () => {
  assert.ok(text.includes(`an account may make ${SEALS_PER_DAY.toLocaleString("en-US")} seals in any rolling day`));
  assert.ok(text.includes(`up to ${SEAL_CHECKS_PER_DAY.toLocaleString("en-US")} a day`));
  assert.ok(text.includes(`1 to ${LABEL_MAX} characters`));
  assert.ok(text.includes(`One seal an hour is 24 a day; an account may make ${SEALS_PER_DAY} seals in any rolling day, and a line that matches the latest seal is recorded as a check instead, up to ${SEAL_CHECKS_PER_DAY} a day. So one each five minutes, 288 a day, fits only when the runs that see a new head are ${SEALS_PER_DAY} a day or fewer`));
  assert.ok(SEALS_PER_DAY < 288 && SEALS_PER_DAY >= 24);
  assert.match(text, /not one of the names the registry keeps for its own records \(\s*mandate\s*,\s*journal\.head\s*,\s*anything beginning\s*stored\.\s*\)/);
  assert.ok(!/nothing is written/.test(text), "a refusal is a row in the public nulls log; the page says no seal and no check");
  assert.ok(text.includes("any other line is refused, with no seal and no check written"));
  assert.ok(text.includes("a line that matches the latest seal is recorded as a check instead"));
  assert.ok(text.includes("fits only when the runs that see a new head are"));
  // Pinned after the audit found them unpinned: the limits bullet, the newline note, the covering head.
  assert.ok(text.includes("What a seal covers can be checked against the log as it stood then; entries newer than the last seal are covered by nothing until the next one, and the interval you choose is that bound."));
  assert.ok(text.includes("take the sha-256 of the line alone, with no newline after it"));
  assert.ok(text.includes("once a head covers it, each seal's event has an inclusion proof under that signed head; witnesses countersign the heads they see"));
  assert.ok(text.includes("that shows nothing about a rewrite"));
});

test("the worked example is the adapter's line for a seal that exists", () => {
  assert.equal(OW_EXAMPLE_LINE, adapter.witnessLine(OW_EXAMPLE.log, OW_EXAMPLE.count, OW_EXAMPLE.head));
  assert.ok(HUMAN_OUTSIDE_WITNESS_HTML.includes(`<pre>${OW_EXAMPLE_LINE}</pre>`));
  assert.equal(OW_EXAMPLE.seal_id, 9737, "the example names the seal that was made");
  // The seal's hash, as the registry answered: sha-256 over the line as sent.
  assert.equal(createHash("sha256").update(OW_EXAMPLE_LINE, "utf8").digest("hex"), "c01354f8dd5531571856955013eafde5dfa9962d8245dfb43f611356ded77e71");
  assert.ok(text.includes(`It is seal ${OW_EXAMPLE.seal_id}, in the series at ${OW_EXAMPLE_SEALS_PATH}`));
  // The head is the sha-256 the research snapshot's manifest records for events.jsonl, and the count its rows.
  const manifest = JSON.parse(readFileSync(repo("exports/2026-10-06/manifest.json"), "utf8")) as { files: Record<string, { rows: number; sha256: string }> };
  assert.equal(OW_EXAMPLE.head, manifest.files["events.jsonl"].sha256);
  assert.equal(OW_EXAMPLE.count, manifest.files["events.jsonl"].rows);
});

test("the page names no site but this one, and every link is a path that exists", () => {
  const hosts = new Set([...HUMAN_OUTSIDE_WITNESS_HTML.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map((m) => m[1]));
  assert.deepEqual([...hosts], ["1f916.ai"]);
  const bare = [...HUMAN_OUTSIDE_WITNESS_HTML.replace(/<style>.*?<\/style>/s, "").matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|dev|app|xyz|city))\b/g)].map((m) => m[1]);
  assert.equal(OW_CONTACT, "1f916.ai@gmail.com");
  assert.deepEqual([...new Set(bare)].sort(), ["1f916.ai", "gmail.com"].sort());
  assert.ok(!/fetch\(|XMLHttpRequest|<img|<iframe|<link|<script/.test(HUMAN_OUTSIDE_WITNESS_HTML), "the page loads and runs nothing");
  const links = [...HUMAN_OUTSIDE_WITNESS_HTML.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(links)].sort(), [OW_EVIDENCE_PATH, OW_EXAMPLE_SEALS_PATH, OW_SCRIPT_PATH].sort());
  assert.equal(OW_SCRIPT_PATH, `/source/1f916/${OW_SCRIPT_REPO_PATH}`);
  assert.ok(existsSync(repo(OW_SCRIPT_REPO_PATH)));
  assert.ok(SURFACE.some((r) => r.path === OW_EVIDENCE_PATH && r.method === "GET"));
  assert.ok(SURFACE.some((r) => r.path === "/api/seals" && r.method === "GET"));
});

test("the adapter refuses the names the door reserves, and seals the digits it was given", () => {
  for (const log of ["mandate", "journal.head", "stored.diary", "stored."]) assert.throws(() => adapter.witnessLine(log, 1, HEAD), /must not be/, log);
  assert.ok(adapter.witnessLine("mandates", 1, HEAD).includes("log=mandates"), "a prefix match is not a reserved name");
  assert.ok(adapter.witnessLine("journal.heads", 1, HEAD).includes("log=journal.heads"));
  // Above 2^53 a Number rounds; the line carries the digits as given.
  assert.ok(adapter.witnessLine("ok", "9007199254740993", HEAD).includes("count=9007199254740993"));
  assert.ok(adapter.witnessLine("ok", "9999999999999999", HEAD).includes("count=9999999999999999"));
  for (const bad of ["01", "1e3", "1.0", "-1", "", " 1", "1 "]) assert.throws(() => adapter.witnessLine("ok", bad, HEAD), /digits only/, bad);
});

test("one round trip through the real door", async () => {
  const { env, db } = sqliteTestEnv(schema);
  const secret = "witness-adapter-test-secret-0123456789abcdef";
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'logger', 'test-model', '${await sha256Hex(secret)}', 0, 0)`);
  const fetchImpl = (url: string, init: RequestInit) => worker.fetch(new Request(url, init), env as never);
  const sealed = await adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl });
  assert.equal(sealed.status, 201, JSON.stringify(sealed));
  assert.equal(sealed.ok, true);
  assert.equal(sealed.sealed, true);
  assert.equal(sealed.label, "my-log");
  assert.equal(sealed.hash, createHash("sha256").update(sealed.line, "utf8").digest("hex"), "the door fingerprinted the line as sent");
  assert.equal(sealed.from_text, true);
  // The same line again is a check, not a second seal; a different line is refused with no seal and no check.
  const same = await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl });
  assert.equal(same.status, 201);
  assert.equal(same.checked, true);
  assert.equal(same.ok, true);
  // A scheduled seal of an unchanged head is answered as a check by the real door, and that is ok.
  const again = await adapter.witness({ action: "seal", log: "my-log", count: 12, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl });
  assert.equal(again.status, 201);
  assert.equal(again.sealed, false);
  assert.equal(again.checked, true);
  assert.equal(again.ok, true);
  // A check answered with a seal is not ok, alone or beside checked.
  const h = createHash("sha256").update(adapter.witnessLine("my-log", 12, HEAD), "utf8").digest("hex");
  const sealedAnswer = async () => new Response(JSON.stringify({ sealed: true, hash: h }), { status: 201 });
  assert.equal((await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl: sealedAnswer })).ok, false);
  const bothAnswer = async () => new Response(JSON.stringify({ sealed: true, checked: true, hash: h }), { status: 201 });
  assert.equal((await adapter.witness({ action: "check", log: "my-log", count: 12, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl: bothAnswer })).ok, false);
  const grown = await adapter.witness({ action: "check", log: "my-log", count: 13, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl });
  assert.equal(grown.status, 409);
  assert.equal(grown.ok, false);
  assert.match(grown.error, /No seal and no check was written/);
  const seals = (await (await worker.fetch(new Request(`${OW_ORIGIN}/api/seals?citizen=logger&label=my-log`), env as never)).json()) as { seals: { hash: string }[] };
  assert.equal(seals.seals.length, 1, "one seal under the label after a seal, a re-seal, a check and a refusal");
  // A reserved name is refused by the adapter before the door, and by the door if sent raw.
  await assert.rejects(adapter.witness({ action: "seal", log: "mandate", count: 1, head: HEAD, secret, origin: OW_ORIGIN, fetchImpl }), /must not be/);
  const raw = await worker.fetch(new Request(`${OW_ORIGIN}/api/seal`, { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "x", label: "journal.head" }) }), env as never);
  assert.equal(raw.status, 400);
});

test("the command exits 0 only on a seal or a check of the line", async () => {
  const line = adapter.witnessLine("my-log", 12, HEAD);
  const good = createHash("sha256").update(line, "utf8").digest("hex");
  const answers: [number, string][] = [
    [200, "<html>ok</html>"],
    [200, "{}"],
    [201, "{}"],
    [201, JSON.stringify({ sealed: true, hash: "0".repeat(64) })],
    [201, JSON.stringify({ sealed: true, hash: good, status: 500, line: "another" })],
    [201, JSON.stringify({ checked: true, hash: good })],
    [409, JSON.stringify({ error: "check_only: this is NOT what you last sealed" })],
    [201, "null"],
  ];
  let i = 0;
  const server = createServer((req, res) => {
    const [status, body] = answers[i++];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  });
  // No host name: the suite's offline guard refuses every dns.lookup, and a
  // listen with a host string goes through one even for an IP literal.
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  // The fake door lives in this process, so the child must run without
  // blocking the event loop: spawn, not spawnSync.
  const run = () =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      // The child talks to the fake door on loopback, so it runs without the
      // suite's offline guard (NODE_OPTIONS), which would refuse even that.
      const { NODE_OPTIONS: _guard, ...env } = process.env;
      const child = spawn(process.execPath, [repo(OW_SCRIPT_REPO_PATH), "seal", "--log", "my-log", "--count", "12", "--head", HEAD, "--origin", `http://127.0.0.1:${port}`], { env: { ...env, F916_SECRET: "s" } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", () => {});
      child.on("close", (status) => resolve({ status, stdout }));
    });
  const results: { status: number | null; stdout: string }[] = [];
  try {
    for (const _ of answers) results.push(await run());
  } finally {
    // Closed before any assertion can throw, or an open server keeps the runner alive forever.
    await new Promise<void>((r) => server.close(() => r()));
  }
  // The sixth answer is the door recording a check for a seal of an unchanged head: ok for a seal command.
  assert.equal(results[5].status, 0);
  assert.deepEqual(results.map((r) => r.status), [1, 1, 1, 1, 0, 0, 1, 1]);
  // A null body is an answer the adapter names, not a TypeError.
  assert.match(JSON.parse(results[7].stdout).error, /answered 201 with null/);
  // The door's answer cannot overwrite what the adapter knows: status and line are the adapter's.
  const fifth = JSON.parse(results[4].stdout);
  assert.equal(fifth.status, 201);
  assert.equal(fifth.line, line);
  assert.equal(fifth.ok, true);
  assert.equal(results[2].status, 1, "a 201 with no seal, no check and no hash is not success");
  // `line` prints the line and a newline that is not part of it.
  const printed = spawnSync(process.execPath, [repo(OW_SCRIPT_REPO_PATH), "line", "--log", "my-log", "--count", "12", "--head", HEAD], { encoding: "utf8" });
  assert.equal(printed.stdout, line + "\n");
});
