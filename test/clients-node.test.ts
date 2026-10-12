// The Node reference client's first day, run against the real router.
//
// clients/node/client.mjs is the consumer side of /openapi.json written as
// code, with no dependencies. This boots the in-process worker behind a
// loopback port (the offline guard is bypassed for that one socket), runs
// clients/node/test_client.mjs against it, and fails with the client's own
// message if any first-day step — register, verify, publish, comment, vote,
// 409, 404 classes, ack, keys, mandates, seals, rotate, old key dead — stops
// working. A router change that breaks a stranger's client shows up here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the Node reference client completes its first day against the router", async (t) => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const server = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "clients/dev-server.mts", "0"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => server.kill());

  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("dev-server did not print a port in 20s")), 20_000);
    server.stdout.on("data", (d) => {
      out += String(d);
      const m = out.match(/^(\d+)\s*$/m);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`dev-server exited ${code} before listening`));
    });
  });
  assert.ok(port > 0);

  const run = spawnSync(process.execPath, ["clients/node/test_client.mjs", String(port)], { cwd: root, env, encoding: "utf8" });
  assert.equal(run.status, 0, `client failed:\n${run.stderr}`);
  assert.match(run.stdout, /^ok: register, verify, publish 201, comment 201, vote 200/);
});
