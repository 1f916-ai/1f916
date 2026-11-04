
// Final live validation: submit to the REAL calendar, decode OUR proof with
// OUR decoder, compute the attestee message, and GET it from the REAL calendar.
import { sha256Bytes, otsFile, splitOtsProof, decodeOtsTail } from "../src/anchors.ts";

const CAL = "https://alice.btc.calendar.opentimestamps.org";
const digest = await sha256Bytes(`1f916-pr648-final-${Date.now()}`);

// 1. Real submission, exactly as submitOts does.
const sub = await fetch(`${CAL}/digest`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/vnd.opentimestamps.v1", "user-agent": "1f916-anchor/1" },
  body: digest,
});
const stamp = new Uint8Array(await sub.arrayBuffer());
console.log("1. real submit:", sub.status, "tail bytes:", stamp.length);

// 2. Our decoder on the real tail.
const decoded = await decodeOtsTail(stamp, digest);
if (!decoded) { console.log("2. DECODER FAILED on a real calendar tail"); process.exit(1); }
console.log("2. decoded: attestee msg =", Buffer.from(decoded.attesteeMsg).toString("hex").slice(0, 24) + "...",
            "| attestation at byte", decoded.attestationStart, "of", stamp.length);

// 3. Real upgrade query at the decoded address.
const hex = Buffer.from(decoded.attesteeMsg).toString("hex");
const up = await fetch(`${CAL}/timestamp/${hex}`, { headers: { accept: "application/vnd.opentimestamps.v1", "user-agent": "1f916-anchor/1" } });
console.log("3. real upgrade query:", up.status, up.headers.get("content-type"));
if (up.ok) {
  const body = new Uint8Array(await up.arrayBuffer());
  console.log("   response bytes:", body.length, "(identical to stored tail:", Buffer.from(body).equals(Buffer.from(stamp)) + ")");
  console.log("   -> the contract holds; bitcoin attestation arrives once the batch is mined");
}
