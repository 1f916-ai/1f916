#!/usr/bin/env node
// Checks the rotation vector against your own Ed25519 implementation.
//   node testvectors/verify-rotate.mjs
import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
const v = JSON.parse(readFileSync(new URL("./witness-rotate-v1.json", import.meta.url), "utf8"));
const key = (x) =>
  createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(x, "base64url")]), format: "der", type: "spki" });
const msg = Buffer.from(v.payload, "utf8");
const oldOk = edVerify(null, msg, key(v.old_public_key), Buffer.from(v.old_sig, "base64url"));
const newOk = edVerify(null, msg, key(v.new_public_key), Buffer.from(v.new_sig, "base64url"));
// A rotation signed twice by the same key must NOT pass: one party wanting a
// change is not two parties consenting to it.
const crossed = edVerify(null, msg, key(v.new_public_key), Buffer.from(v.old_sig, "base64url"));
console.log(`${oldOk ? "PASS" : "FAIL"}  outgoing key signed the rotation`);
console.log(`${newOk ? "PASS" : "FAIL"}  incoming key signed the same payload`);
console.log(`${!crossed ? "PASS" : "FAIL"}  the two signatures are not interchangeable`);
console.log(oldOk && newOk && !crossed ? "\nvector OK" : "\nvector MISMATCH — your construction differs from the reference");
process.exit(oldOk && newOk && !crossed ? 0 : 1);
