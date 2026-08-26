// The deterministic suite does not open sockets by accident.
//
// Not "cannot": this is a preload, not a sandbox, and the block at the bottom
// of this file names the ways out that review found. What it does is make
// the spelling of a request stop mattering.
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
// you spell it, and `npm test` goes red. Removing the --import from the test
// script makes it green again, and so do the four routes named below, which is
// why they are named rather than left implied.
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
// DNS twice over, because the first attempt at this closed half of it.
//
// Patching dns.lookup alone left new dns.Resolver().resolve4() open, and then
// patching the Resolver PROTOTYPE alone left dns.resolve4() open, because Node
// binds the module-level resolve functions to a default resolver instance at
// module load, before this preload runs. Both spellings returned real A records
// for the live origin under `npm test`. So: the prototypes, and the fifteen
// module-level names on each of dns and dns.promises.
for (const Cls of [dns.Resolver, dns.promises.Resolver]) {
  for (const method of Object.getOwnPropertyNames(Cls.prototype)) {
    if (method.startsWith("resolve") || method === "reverse") {
      Cls.prototype[method] = refuse(`dns.Resolver.${method}`);
    }
  }
}
for (const [label, mod] of [["dns", dns], ["dns.promises", dns.promises]]) {
  for (const name of Object.keys(mod)) {
    if (name.startsWith("resolve") || name === "reverse") mod[name] = refuse(`${label}.${name}`);
  }
}

// WHAT THIS DOES NOT COVER, named rather than left to be discovered. Every one
// is a way of LEAVING this thread rather than a way of writing a request, so
// none of them is something a probe gets written as by accident:
//
//   module.register(). Its loader hooks run on a thread --import does not
//   reach, and a plain fetch() inside an initialize() hook gets a 200.
//   module.registerHooks(), the in-thread form, is guarded.
//   a worker_thread whose code is CommonJS. An ESM eval worker and a worker
//   loaded from a file both inherit --import and are guarded; a CJS eval
//   worker is not.
//   a child process. execSync("curl ...") never enters this runtime, and
//   spawning node with NODE_OPTIONS stripped starts a fresh unguarded one.
//   process.binding("tcp_wrap"), which opens a raw socket beneath all of this.
//
// Closing those means a sandbox, not a preload. The guard is here to stop a
// probe being added to the deterministic suite by habit, and it does that.
