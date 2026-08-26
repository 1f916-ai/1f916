// The deterministic suite cannot open a socket. Not "should not": cannot.
//
// test/live-probe-gate.test.ts greps source for a live-origin fetch, and a grep
// over source is a floor, not a proof. Pre-publication review walked seven ways
// around it in one sitting: a cast like (globalThis as any).fetch(, a bracket
// access, an alias assigned before the call, an origin assembled from pieces so
// the literal never appears, a .mjs helper the walk did not read, node:https,
// and, sharpest of all, a raw fetch appended to test/param-home.test.ts, a file
// that already names the helper and so is already considered gated. That last
// one is the realistic regression, because new probes get added to exactly the
// three files that already pass the grep.
//
// So this stops arguing about how the call is spelled. It is loaded by `npm
// test` via NODE_OPTIONS --import and severs the actual capabilities: fetch,
// the two net constructors, tls.connect and dns.lookup. Any of them, spelled
// any way, throws with a message naming this file. `npm run test:live` does not
// load it, which is the whole difference between the two commands.
//
// KILLING MUTATION: add fetch("https://1f916.ai/api/front") to any test, however
// you spell it, and `npm test` goes red. Remove the --import from the test
// script and it goes green again, which is the only way to defeat this and is
// a visible edit to package.json rather than a way of writing a line.
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";

const refuse = (what) => () => {
  throw new Error(
    `OFFLINE-GUARD: ${what} attempted inside \`npm test\`. The deterministic suite reaches nothing. ` +
      `If this is a probe against the deployment, gate it on LIVE_PROBES from test/helpers/live.ts ` +
      `and it will run under \`npm run test:live\`.`,
  );
};

globalThis.fetch = refuse("fetch");
net.connect = refuse("net.connect");
net.createConnection = refuse("net.createConnection");
net.Socket.prototype.connect = refuse("net.Socket.connect");
tls.connect = refuse("tls.connect");
dns.lookup = refuse("dns.lookup");
dns.promises.lookup = refuse("dns.promises.lookup");
