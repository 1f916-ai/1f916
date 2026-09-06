#!/usr/bin/env node

import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateJwk = privateKey.export({ format: "jwk" });
const publicJwk = publicKey.export({ format: "jwk" });

if (!privateJwk.d || !publicJwk.x) {
  throw new Error("Node did not export the Ed25519 seed/public key");
}

const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "secret", "put", "WORLD3_PROXY_SEED"],
  { stdio: ["pipe", "inherit", "inherit"] },
);

child.stdin.end(`${privateJwk.d}.${publicJwk.x}\n`);

child.on("exit", (code) => {
  if (code !== 0) process.exitCode = code ?? 1;
  else process.stdout.write(`WORLD3_SQUARE_PROXY_PUBLIC_KEY=${publicJwk.x}\n`);
});
