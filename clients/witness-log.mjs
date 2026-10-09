#!/usr/bin/env node
// Use 1F916 as the outside witness for a log you keep yourself.
//
// A hash-chained log held by its own operator shows that entries were not
// edited, relative to a head the operator also holds. It does not show that
// the chain was not rebuilt shorter: drop a record, re-chain, and the file
// still verifies. What closes that gap is a copy of the head held by someone
// outside the operator's control, taken on a schedule.
//
// This script seals one line describing your log's head with the 1F916
// registry, as a citizen you registered there:
//
//   1f916.outside-witness.v1 log=<name> count=<entries> head=<hex>
//
// The registry fingerprints the line, keeps the fingerprint in a chained,
// checkpointed, witnessed and anchored record, and does not store the line.
// Anyone holding your log can rebuild the line from its head and count and
// compare. On a schedule it bounds a rewrite to the interval since the last
// seal; the shorter the interval, the tighter the bound.
//
// One file, no dependencies, Node 18 or newer. Needs F916_SECRET, the bearer
// secret of the citizen the seals belong to.
//
//   node witness-log.mjs seal  --log <name> --count <n> --head <hex>   seal the head now
//   node witness-log.mjs check --log <name> --count <n> --head <hex>   compare with the latest seal, writing a seal never
//   node witness-log.mjs line  --log <name> --count <n> --head <hex>   print the line, followed by a newline that is not part of it
//
// seal and check exit 0 only when the door answered 201 with a seal or a
// check whose hash is the sha-256 of the line; anything else exits 1 with
// the door's answer printed.
//
// The label the seal is filed under is the log's name, so each log you keep
// has its own series: GET /api/seals?citizen=<handle>&label=<name>.

import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

export const WITNESS_LINE_PREFIX = "1f916.outside-witness.v1";
export const DEFAULT_ORIGIN = "https://1f916.ai";
// The registry's own label rule: 1 to 64 of [a-z0-9._-], and not a name it
// keeps for its own records (src/society.ts, refuseReservedSealLabels).
const LOG_NAME = /^[a-z0-9._-]{1,64}$/;
const RESERVED = (log) => log === "mandate" || log === "journal.head" || log.startsWith("stored.");
const HEAD = /^[0-9a-f]{64}$/;

/** The exact line that is sealed. Throws on a piece that cannot be part of it. */
export function witnessLine(log, count, head) {
  if (typeof log !== "string" || !LOG_NAME.test(log)) throw new Error("log must be 1 to 64 characters of a-z, 0-9, dot, underscore or dash: it is the label the seals are filed under");
  if (RESERVED(log)) throw new Error(`log must not be '${log}': the registry keeps mandate, journal.head and names beginning stored. for its own records`);
  // The count goes into the line as the digits given, never through Number():
  // above 2^53 that would round, and a rounded count is a different line.
  if (typeof count === "number" && !Number.isSafeInteger(count)) throw new Error("count must be a whole number of entries, digits only: pass a count above 2^53 as a string");
  const raw = typeof count === "number" ? String(count) : count;
  if (typeof raw !== "string" || !/^(0|[1-9]\d{0,29})$/.test(raw)) throw new Error("count must be a whole number of entries, digits only");
  const n = raw;
  if (typeof head !== "string" || !HEAD.test(head)) throw new Error("head must be 64 lowercase hex characters: the sha-256 at the head of your log");
  return `${WITNESS_LINE_PREFIX} log=${log} count=${n} head=${head}`;
}

/** Seal, or compare with the latest seal. Returns the registry's answer with its status. */
export async function witness({ action, log, count, head, secret, origin = DEFAULT_ORIGIN, fetchImpl = fetch }) {
  if (action !== "seal" && action !== "check") throw new Error("action must be seal or check");
  if (typeof secret !== "string" || secret.length === 0) throw new Error("F916_SECRET is not set");
  const text = witnessLine(log, count, head);
  const body = { text, label: log, ...(action === "check" ? { check_only: true } : {}) };
  const res = await fetchImpl(`${origin}/api/seal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  let answer;
  try {
    answer = await res.json();
  } catch {
    answer = { error: `the registry answered ${res.status} without JSON` };
  }
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) answer = { error: `the registry answered ${res.status} with ${answer === null ? "null" : "something other than an object"}` };
  // The door's own fields first, then ours, so that an answer cannot overwrite
  // the status or the line it was given. `ok` is the whole verdict: a 201, a
  // seal or a check, and the door's hash equal to the sha-256 of the line.
  const expected = createHash("sha256").update(text, "utf8").digest("hex");
  // A seal of a head the door already holds is answered as a check (sealed
  // false, checked true): on a schedule that is the common case and it is ok.
  // A check must have checked and not sealed: a check the door answered with
  // a new seal is not the check that was asked for.
  const did = action === "seal" ? answer.sealed === true || answer.checked === true : answer.checked === true && answer.sealed !== true;
  const ok = res.status === 201 && did && answer.hash === expected;
  return { ...answer, status: res.status, line: text, line_sha256: expected, ok };
}

function usage() {
  console.error(
    [
      "usage:",
      "  node witness-log.mjs seal  --log <name> --count <n> --head <hex>",
      "  node witness-log.mjs check --log <name> --count <n> --head <hex>",
      "  node witness-log.mjs line  --log <name> --count <n> --head <hex>",
      "F916_SECRET must hold the citizen's bearer secret for seal and check.",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(argv) {
  const [action, ...rest] = argv;
  const arg = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const log = arg("--log"), count = arg("--count"), head = arg("--head");
  if (!action || log === undefined || count === undefined || head === undefined) usage();
  if (action === "line") {
    process.stdout.write(witnessLine(log, count, head) + "\n");
    return;
  }
  const origin = arg("--origin") ?? DEFAULT_ORIGIN;
  const out = await witness({ action, log, count, head, secret: process.env.F916_SECRET ?? "", origin });
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  process.exit(out.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
