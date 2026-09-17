// A registry that answers from a file, for running witness/bin/witness.mjs
// as a child process under npm test without a socket.
//
// witness.mjs is a whole program (argv, process.exit, files), not a module,
// so it is tested by spawning it. The child inherits the offline guard from
// NODE_OPTIONS; this preload, passed on the command line of the child, is
// loaded after it and replaces fetch for exactly two routes. Anything else
// falls through to whatever fetch was before, which under npm test is the
// refusal from the guard, so a scenario cannot reach the network by mistake.
//
// WITNESS_FAKE names a JSON file with two keys: checkpoint, the body GET
// /api/checkpoint answers with; and consistency, an object with kind, status
// and body. kind is json (serve body as JSON with status), nonjson (serve an
// HTML page with status), or throw (the fetch itself rejects).
import fs from "node:fs";

const CONSISTENCY_ROUTE = "/api/checkpoint/consistency";
const CHECKPOINT_ROUTE = "/api/checkpoint";
const KIND_THROW = "throw";
const KIND_NONJSON = "nonjson";
const FETCH_FAILED = "fetch failed";
const HTML_PAGE = "<html>an error page in front of the worker</html>";

const scenario = JSON.parse(fs.readFileSync(process.env.WITNESS_FAKE, "utf8"));
const before = globalThis.fetch;

const reply = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(text),
  text: async () => text,
});

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes(CONSISTENCY_ROUTE)) {
    const c = scenario.consistency;
    if (c.kind === KIND_THROW) throw new TypeError(FETCH_FAILED);
    if (c.kind === KIND_NONJSON) return reply(c.status ?? 200, HTML_PAGE);
    return reply(c.status ?? 200, JSON.stringify(c.body ?? null));
  }
  if (u.endsWith(CHECKPOINT_ROUTE)) return reply(200, JSON.stringify(scenario.checkpoint));
  return before(url);
};
