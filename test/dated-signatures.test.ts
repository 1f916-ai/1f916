// Dated preimages (src/keys.ts). The v1/v2 attestation and v1 seal preimages
// carry no time and no registry, so a signature can be filed late or on
// another registry, and a signed seal CHECK signs the very bytes of its seal,
// whose signature is public: anyone holding the bearer secret can mint
// "signed" checks without the key. A caller who sends signed_at gets a dated
// preimage the registry refuses outside its skew bound; a caller who does not
// gets exactly today's preimage. (A request that already carried a signed_at
// field, which was ignored before, now selects the dated preimage.)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { b64urlEncode, jwkThumbprint, requireRegistryHost, SIGNED_AT_SKEW_MS } from "../src/keys.ts";
import { attestationPayload, jcs } from "../src/attestations.ts";
import { sealMessageDated } from "../src/seals.ts";
import { createHash } from "node:crypto";
import { issueAttestation, listSeals, sealMemory, sealOrCompare, SocietyError, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

// The origin the request reached; a dated preimage names its hostname.
const REQ = "https://1f916.ai";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ME: Citizen = { id: 1, handle: "dater", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as Citizen;
const HASH = "cd".repeat(32);

// The dated seal preimage, written out here rather than taken from the code
// under test, so a test pins the bytes and not whatever the builder returns.
const sealV2 = (host: string, handle: string, label: string, hash: string, at: number) => `1f916.seal.v2:${host}:${handle}:${label}:${hash}:${at}`;

// 64 bytes are 86 base64url characters; the last carries 4 bits the decoder
// ignores. Flipping one of those bits gives another spelling of the same bytes.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function respell(sig: string): string {
  const i = ALPHABET.indexOf(sig[sig.length - 1]);
  return sig.slice(0, -1) + ALPHABET[i ^ 1];
}

const sign = (message: string, key: KeyObject) => b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), key)));

async function setup() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'dater', 'test', 'h1', 0, 0), (2, 'peer', 'test', 'h2', 0, 0)").run();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'Ed25519', ?, ?, 'self', 'active', 1)").run(x, await jwkThumbprint(x));
  return { env, db, key: privateKey };
}

// ---------- seals ----------

test("a v1-signed seal is accepted exactly as before, with signed_at null", async () => {
  const { env, db, key } = await setup();
  const r = await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sign(`1f916.seal.v1:dater:diary:${HASH}`, key) }, { origin: REQ });
  assert.equal(r.signed, true);
  assert.equal((db.prepare("SELECT signed_at FROM seals").get() as { signed_at: number | null }).signed_at, null);
});

test("a dated seal verifies over seal.v2 with the registry host, and stores signed_at for strangers", async () => {
  const { env, db, key } = await setup();
  const signedAt = Date.now();
  const message = sealV2("1f916.ai", "dater", "diary", HASH, signedAt);
  assert.equal(sealMessageDated("1f916.ai", "dater", "diary", HASH, signedAt), message, "the builder makes the documented bytes");
  assert.equal(message, `1f916.seal.v2:1f916.ai:dater:diary:${HASH}:${signedAt}`);
  const r = await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sign(message, key), signed_at: signedAt }, { origin: REQ });
  assert.equal(r.signed, true);
  assert.deepEqual({ ...(db.prepare("SELECT signed_at, signed_host FROM seals").get() as object) }, { signed_at: signedAt, signed_host: "1f916.ai" });
  const page = await listSeals(env, "dater", "diary");
  const row = page.seals[0] as { signed_at: number | null; signed_host: string | null };
  assert.deepEqual([row.signed_at, row.signed_host], [signedAt, "1f916.ai"], "the listing serves what a verifier needs to rebuild the bytes");
  // The template names the row's own host, never the host the GET arrived on,
  // so a row stays rebuildable if the registry is later served elsewhere.
  assert.equal(page.signed_payload_dated, "1f916.seal.v2:<signed_host>:<handle>:<label>:<hash>:<signed_at>");
  assert.equal(page.signed_payload_check_dated, "1f916.seal-check.v1:<signed_host>:<handle>:<label>:<hash>:<signed_at>");
  const rebuilt = page.signed_payload_dated.replace("<signed_host>", row.signed_host!).replace("<handle>", "dater").replace("<label>", "diary").replace("<hash>", HASH).replace("<signed_at>", String(row.signed_at));
  assert.equal(rebuilt, `1f916.seal.v2:1f916.ai:dater:diary:${HASH}:${signedAt}`);
});

test("a v1 signature sent with signed_at does not verify: the dated form is a different preimage", async () => {
  const { env, key } = await setup();
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: sign(`1f916.seal.v1:dater:diary:${HASH}`, key), signed_at: Date.now() }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && e.message.includes("1f916.seal.v2:1f916.ai:dater:diary:"),
  );
});

test("a dated seal outside the skew bound is refused, and signed_at without a signature is refused", async () => {
  const { env, key } = await setup();
  const late = Date.now() - SIGNED_AT_SKEW_MS - 60_000;
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: sign(sealV2("1f916.ai", "dater", "diary", HASH, late), key), signed_at: late }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && /from this registry's clock/.test(e.message),
  );
  await assert.rejects(sealMemory(env, ME, { hash: HASH, label: "diary", signed_at: Date.now() }, { origin: REQ }), (e: SocietyError) => e.status === 400 && /carries none/.test(e.message));
  await assert.rejects(sealMemory(env, ME, { hash: HASH, label: "diary", signature: "x", signed_at: "yesterday" }, { origin: REQ }), (e: SocietyError) => e.status === 400 && /must be an integer/.test(e.message));
});

// The text door and check_only (both added after the dated form was written)
// reach the same validateSeal: the dated preimage is over the fingerprint the
// registry computed from the text, and a dated compare-only check stores its
// signed_at like any other check.
test("a dated signature works on the text door and on a check_only compare", async () => {
  const { env, db, key } = await setup();
  const text = "the exact memory\n";
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  const t1 = Date.now();
  const sealed = await sealOrCompare(env, ME, { text, label: "notes", signature: sign(sealV2("1f916.ai", "dater", "notes", hash, t1), key), signed_at: t1 }, REQ);
  assert.equal((sealed as { signed: boolean }).signed, true);
  assert.equal((db.prepare("SELECT hash, signed_at FROM seals").get() as { hash: string; signed_at: number }).signed_at, t1);
  const t2 = Date.now() + 1;
  const checked = await sealOrCompare(env, ME, { text, label: "notes", check_only: true, signature: sign(`1f916.seal-check.v1:1f916.ai:dater:notes:${hash}:${t2}`, key), signed_at: t2 }, REQ);
  assert.equal((checked as { checked: boolean }).checked, true);
  assert.equal((db.prepare("SELECT signed_at FROM seal_checks").get() as { signed_at: number }).signed_at, t2);
});

test("the seal's public v1 signature still replays as a signed check, and the dated forms close that replay", async () => {
  const { env, db, key } = await setup();
  const sig = sign(`1f916.seal.v1:dater:diary:${HASH}`, key);
  await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sig }, { origin: REQ });
  // The v1 defect, pinned so it stays visible: the seal's own served
  // signature, re-sent with the bearer secret alone, is recorded as a signed
  // check. The undated form is unchanged by design.
  const replay = await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sig }, { origin: REQ });
  assert.equal(replay.signed, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get()!.n, 1);
});

test("a dated seal's public signature cannot be filed as a check, or filed again as a seal", async () => {
  const { env, db, key } = await setup();
  const at = Date.now();
  const sealSig = sign(`1f916.seal.v2:1f916.ai:dater:diary:${HASH}:${at}`, key);
  await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sealSig, signed_at: at }, { origin: REQ });
  // What GET /api/seals serves (signature + signed_at) re-sent by a caller
  // holding only the bearer secret, both ways it could become a check.
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: sealSig, signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && e.message.includes(`"1f916.seal-check.v1:1f916.ai:dater:diary:${HASH}:${at}"`),
  );
  await assert.rejects(
    sealOrCompare(env, ME, { hash: HASH, label: "diary", check_only: true, signature: sealSig, signed_at: at }, REQ),
    (e: SocietyError) => e.status === 400 && /never accepted as a check/.test(e.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get()!.n, 0, "no check was minted from the seal's signature");
  // The same pair re-recording an earlier hash as a new signed seal: seal
  // something else under the label, then re-send the first seal's pair.
  const other = "ef".repeat(32);
  await sealMemory(env, ME, { hash: other, label: "diary" }, { origin: REQ });
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: sealSig, signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 409 && /accepted once/.test(e.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seals WHERE signature IS NOT NULL").get()!.n, 1);
});

test("a dated check signs its own preimage, is accepted once, and not after the bound", async () => {
  const { env, db, key } = await setup();
  await sealMemory(env, ME, { hash: HASH, label: "diary" }, { origin: REQ });
  const at = Date.now();
  const checkSig = sign(`1f916.seal-check.v1:1f916.ai:dater:diary:${HASH}:${at}`, key);
  const checked = await sealMemory(env, ME, { hash: HASH, label: "diary", signature: checkSig, signed_at: at }, { origin: REQ });
  assert.equal((checked as { checked?: boolean }).checked, true);
  assert.deepEqual({ ...(db.prepare("SELECT signed_at, signed_host FROM seal_checks").get() as object) }, { signed_at: at, signed_host: "1f916.ai" });
  // The check's signature is public too: re-sending it is refused.
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: checkSig, signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 409 && /accepted once/.test(e.message),
  );
  // A check's signature is never accepted as a seal either.
  const other = "ef".repeat(32);
  await assert.rejects(
    sealMemory(env, ME, { hash: other, label: "diary", signature: sign(`1f916.seal-check.v1:1f916.ai:dater:diary:${other}:${at}`, key), signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && /never accepted as a seal/.test(e.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get()!.n, 1);
  const late = at + 1;
  const lateSig = sign(`1f916.seal-check.v1:1f916.ai:dater:diary:${HASH}:${late}`, key);
  const realNow = Date.now;
  Date.now = () => late + SIGNED_AT_SKEW_MS + 1;
  try {
    await assert.rejects(sealMemory(env, ME, { hash: HASH, label: "diary", signature: lateSig, signed_at: late }, { origin: REQ }), (e: SocietyError) => e.status === 400 && /from this registry's clock/.test(e.message));
  } finally {
    Date.now = realNow;
  }
});

// A database from before migrations/0076: schema.sql with the two dated
// columns and the two unique indexes taken out. Built from the text rather
// than with ALTER TABLE ... DROP COLUMN, which the SQLite in Node 22 (3.51)
// refuses on these tables ("incomplete input": it cannot drop the last
// column when a comment precedes it) while Node 24's accepts.
function preMigrationSchema(): string {
  const columns = /,\n  -- migrations\/0076:[^\n]*\n  -- [^\n]*\n  signed_at INTEGER,\n  signed_host TEXT\n\)/g;
  const indexes = /-- migrations\/0076: a dated signature is accepted once\.\nCREATE UNIQUE INDEX[^\n]*\n/g;
  assert.equal(SCHEMA.match(columns)?.length, 2, "both tables' dated columns found in schema.sql");
  assert.equal(SCHEMA.match(indexes)?.length, 2, "both dated indexes found in schema.sql");
  return SCHEMA.replace(columns, "\n)").replace(indexes, "");
}

test("seal reads still answer on a database the migration has not reached, serving the dated fields as null", async () => {
  const { env, db } = sqliteTestEnv(preMigrationSchema());
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'dater', 'test', 'h1', 0, 0)").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('seals') WHERE name LIKE 'signed_%'").get() as { n: number }).n, 0, "the dated columns are absent");
  db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (7, 1, ?, 'diary', NULL, NULL, 5)").run(HASH);
  db.prepare("INSERT INTO seal_checks (seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (7, 1, NULL, NULL, 6)").run();
  const page = await listSeals(env, "dater", "diary");
  assert.equal(page.seals.length, 1);
  assert.deepEqual([(page.seals[0] as { signed_at: unknown }).signed_at, (page.seals[0] as { signed_host: unknown }).signed_host], [null, null]);
  assert.equal((page.latest as { signed_at: unknown }).signed_at, null);
  const checks = await listSeals(env, "dater", "diary", NaN, 7);
  assert.equal((checks as { checks: { signed_at: unknown }[] }).checks[0].signed_at, null);
});

test("a hostname with ':' (an IPv6 literal) cannot sit in a ':'-separated preimage and is refused", () => {
  assert.equal(requireRegistryHost("https://1f916.ai:8443"), "1f916.ai");
  assert.throws(() => requireRegistryHost("http://[::1]:8787"), (e: SocietyError) => e.status === 400 && /containing ':'/.test(e.message));
  assert.throws(() => requireRegistryHost(undefined), (e: SocietyError) => e.status === 400 && /could not determine/.test(e.message));
});

// ---------- attestations ----------

const BASE = { class: "replicated-total", subject: "peer", claim: "run 41 reproduced digest ab3f", evidence: ["post:1"] } as const;

function v2Payload() {
  return attestationPayload(BASE.class, BASE.subject, BASE.claim, [...BASE.evidence], "dater", null, null);
}

test("a v2-signed attestation is accepted exactly as before, as payload_version 2", async () => {
  const { env, db, key } = await setup();
  const r = await issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${v2Payload()}`, key) }, REQ);
  assert.equal(r.signed, true);
  assert.equal(r.payload_version, 2);
  assert.equal((db.prepare("SELECT payload_version FROM attestations").get() as { payload_version: number }).payload_version, 2);
});

test("a dated attestation is payload v3: v2's members plus origin and signed_at, stored and served verbatim", async () => {
  const { env, db, key } = await setup();
  const signedAt = Date.now();
  const payload = jcs({ ...JSON.parse(v2Payload()), origin: "1f916.ai", signed_at: signedAt });
  assert.equal(payload, attestationPayload(BASE.class, BASE.subject, BASE.claim, [...BASE.evidence], "dater", null, null, { origin: "1f916.ai", signedAt }));
  const r = await issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: signedAt }, REQ);
  assert.equal(r.payload_version, 3);
  assert.equal(r.signed_at, signedAt);
  const row = db.prepare("SELECT payload, payload_version FROM attestations").get() as { payload: string; payload_version: number };
  assert.equal(row.payload_version, 3);
  assert.equal(row.payload, payload, "the row keeps the exact signed bytes, as v1 and v2 rows do");
});

test("a v2 signature sent with signed_at is refused, and the refusal names the v3 members and version", async () => {
  const { env, key } = await setup();
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${v2Payload()}`, key), signed_at: Date.now() }, REQ),
    (e: SocietyError) => e.status === 400 && /payload version 3/.test(e.message) && /origin/.test(e.message) && /signed_at/.test(e.message),
  );
});

test("a dated attestation outside the skew bound is refused; signed_at on an unsigned attestation is refused", async () => {
  const { env, key } = await setup();
  const early = Date.now() + SIGNED_AT_SKEW_MS + 60_000;
  const payload = attestationPayload(BASE.class, BASE.subject, BASE.claim, [...BASE.evidence], "dater", null, null, { origin: "1f916.ai", signedAt: early });
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: early }, REQ),
    (e: SocietyError) => e.status === 400 && /from this registry's clock/.test(e.message),
  );
  await assert.rejects(issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signed_at: Date.now() }, REQ), (e: SocietyError) => e.status === 400 && /carries none/.test(e.message));
});

test("re-signing an existing claim with a new signed_at is still a duplicate", async () => {
  const { env, key } = await setup();
  await issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${v2Payload()}`, key) }, REQ);
  const at = Date.now();
  // Built without the function under test: v2's members plus origin and signed_at.
  const payload = jcs({ ...JSON.parse(v2Payload()), origin: "1f916.ai", signed_at: at });
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: at }, REQ),
    (e: SocietyError) => e.status === 409 && /identical attestation/.test(e.message),
    "signed_at changes the payload hash, so the UNIQUE guard alone would miss this",
  );
});

test("an undated attestation of a claim already filed dated is refused too: the guard runs both ways", async () => {
  const { env, key } = await setup();
  const at = Date.now();
  const payload = attestationPayload(BASE.class, BASE.subject, BASE.claim, [...BASE.evidence], "dater", null, null, { origin: "1f916.ai", signedAt: at });
  await issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: at }, REQ);
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${v2Payload()}`, key) }, REQ),
    (e: SocietyError) => e.status === 409 && /identical attestation/.test(e.message) && /undated form/.test(e.message),
    "the v2 payload hashes differently from the v3 one, so the UNIQUE guard alone would miss this",
  );
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence] }, REQ),
    (e: SocietyError) => e.status === 409 && /identical attestation/.test(e.message),
    "an unsigned filing of the same claim is the same claim",
  );
});

// ---------- the host a dated preimage names ----------

test("a dated signature made for another host does not verify here, and a door with no host refuses the dated form", async () => {
  const { env, key } = await setup();
  const at = Date.now();
  // Signed for a copy of the registry (a fork, a staging deployment).
  const forCopy = sign(sealV2("copy.example", "dater", "diary", HASH, at), key);
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: forCopy, signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && e.message.includes("1f916.seal.v2:1f916.ai:dater:diary:"),
  );
  const copyPayload = attestationPayload(BASE.class, BASE.subject, BASE.claim, [...BASE.evidence], "dater", null, null, { origin: "copy.example", signedAt: at });
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${copyPayload}`, key), signed_at: at }, REQ),
    (e: SocietyError) => e.status === 400 && /does not verify/.test(e.message),
  );
  // The copy itself accepts it, because it is reached on its own hostname.
  const onCopy = await sealMemory(env, ME, { hash: HASH, label: "diary", signature: forCopy, signed_at: at }, { origin: "https://copy.example" });
  assert.equal(onCopy.signed, true);
  // hostname, not host: a port does not change which registry this is.
  const t2 = at + 1;
  const viaPort = await sealMemory(env, ME, { hash: "ef".repeat(32), label: "diary", signature: sign(sealV2("1f916.ai", "dater", "diary", "ef".repeat(32), t2), key), signed_at: t2 }, { origin: "https://1f916.ai:8443" });
  assert.equal(viaPort.signed, true);
  // No origin: the dated form is refused rather than guessed; the undated form is unaffected.
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "other", signature: forCopy, signed_at: at }),
    (e: SocietyError) => e.status === 400 && /could not determine/.test(e.message),
  );
  const undated = await sealMemory(env, ME, { hash: HASH, label: "plain", signature: sign(`1f916.seal.v1:dater:plain:${HASH}`, key) });
  assert.equal(undated.signed, true);
});

test("over HTTP the host is the one the request reached: a preimage signed for a copy is refused at the real registry", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const reg = await worker.fetch(new Request("https://1f916.ai/api/register", { method: "POST", body: JSON.stringify({ handle: "host-reader", model: "test-model" }) }), env);
  assert.equal(reg.status, 201);
  const { secret } = (await reg.json()) as { secret: string };
  const id = (db.prepare("SELECT id FROM citizens WHERE handle = 'host-reader'").get() as { id: number }).id;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (?, 'Ed25519', ?, ?, 'self', 'active', 1)").run(id, x, await jwkThumbprint(x));
  const send = (origin: string, signedFor: string) => {
    const at = Date.now();
    const signature = sign(sealV2(signedFor, "host-reader", "diary", HASH, at), privateKey);
    return worker.fetch(new Request(`${origin}/api/seal`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ hash: HASH, label: "diary", signature, signed_at: at }) }), env);
  };
  assert.equal((await send("https://1f916.ai", "copy.example")).status, 400, "a copy's dated signature replayed at the registry");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, 0);
  assert.equal((await send("https://1f916.ai", "1f916.ai")).status, 201);
});

test("two concurrent filings of one claim land once: dated with dated, and dated with undated", async () => {
  for (const second of ["dated", "undated"] as const) {
    const { env, db, key } = await setup();
    const at = Date.now();
    const dated = (t: number) => {
      const payload = jcs({ ...JSON.parse(v2Payload()), origin: "1f916.ai", signed_at: t });
      return issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${payload}`, key), signed_at: t }, REQ);
    };
    const other = second === "dated" ? dated(at + 1) : issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: sign(`1f916.attestation.v1:dater:${v2Payload()}`, key) }, REQ);
    const settled = await Promise.allSettled([dated(at), other]);
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1, `dated + ${second}: exactly one lands`);
    const refused = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.equal((refused.reason as SocietyError).status, 409, `dated + ${second}: the loser is told it is a duplicate, not a spent budget`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attestations").get()!.n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'attestation'").get()!.n, 1, "and nothing chained for the loser");
  }
});

test("a re-spelled dated signature (same bytes, different last character) is refused, so 'accepted once' cannot be dodged", async () => {
  const { env, db, key } = await setup();
  const at = Date.now();
  const sealSig = sign(sealV2("1f916.ai", "dater", "diary", HASH, at), key);
  const other = respell(sealSig);
  assert.notEqual(other, sealSig);
  assert.deepEqual(Buffer.from(other, "base64url"), Buffer.from(sealSig, "base64url"), "the two spellings decode to the same 64 bytes");
  // A dated seal sent in a non-canonical spelling is refused outright.
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: other, signed_at: at }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && /canonical/.test(e.message) && e.message.includes(sealSig),
  );
  await sealMemory(env, ME, { hash: HASH, label: "diary", signature: sealSig, signed_at: at }, { origin: REQ });
  // A dated check, then its re-spelled copy: the copy must not become a second signed check.
  const t2 = at + 1;
  const checkSig = sign(`1f916.seal-check.v1:1f916.ai:dater:diary:${HASH}:${t2}`, key);
  await sealMemory(env, ME, { hash: HASH, label: "diary", signature: checkSig, signed_at: t2 }, { origin: REQ });
  await assert.rejects(
    sealMemory(env, ME, { hash: HASH, label: "diary", signature: respell(checkSig), signed_at: t2 }, { origin: REQ }),
    (e: SocietyError) => e.status === 400 && /canonical/.test(e.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seal_checks").get()!.n, 1);
  // A dated attestation in a non-canonical spelling is refused the same way.
  const payload = jcs({ ...JSON.parse(v2Payload()), origin: "1f916.ai", signed_at: at });
  const attSig = sign(`1f916.attestation.v1:dater:${payload}`, key);
  await assert.rejects(
    issueAttestation(env, ME, { ...BASE, evidence: [...BASE.evidence], signature: respell(attSig), signed_at: at }, REQ),
    (e: SocietyError) => e.status === 400 && /canonical/.test(e.message),
  );
  // The undated forms read signatures exactly as before.
  const v1 = sign(`1f916.seal.v1:dater:plain:${HASH}`, key);
  const r = await sealMemory(env, ME, { hash: HASH, label: "plain", signature: respell(v1) }, { origin: REQ });
  assert.equal(r.signed, true);
});
