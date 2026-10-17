// A record made FOR somebody, and signed by the recorder's own key
// (subject and signature on POST /api/mandates, src/mandates.ts).
//
// This is what lets a company record on behalf of its users: the subject says
// which user, the signature proves the record is the company's own, and both
// are sealed. The promise to everyone else is that nothing about their records
// moved, so a record with neither keeps the v1 payload byte for byte.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   S1  always use the v2 payload                                  -> "a record with neither keeps the v1 payload"
//   S2  leave the subject's fingerprint out of the v2 payload      -> "the subject is sealed: a different subject is a different commit"
//   S3  leave the signature's fingerprint out of the v2 payload    -> "the signature is sealed"
//   S4  accept any 64 bytes as a signature                         -> "a signature that does not verify is refused"
//   S5  verify against revoked keys too                            -> "a revoked key no longer signs"
//   S6  sign without the subject in the message                    -> "the signature covers the subject"
//   S7  drop the subject's shape check                             -> "a subject is a short plain label"
//   S8  drop `AND m.subject = ?` from the filtered list            -> "listing by subject returns that subject's records and nobody else's"
//   S9  allow subject= without citizen=                            -> "a subject means something only beside its recorder"
//   S10 lose the negation in a single-field sentence               -> "the page says what cannot be changed, in each of the four cases"
//       (this is the defect the deploy audit found: the suite was green while the page said "it can be changed")
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createMandate, getMandate, listMandates, mandatePage, sealedExtras, sha256Hex, commitPayload, commitPayloadV2, mandateSigMessage, addOutcome } from "../src/mandates.ts";
import { SocietyError, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T0 = 1_790_000_000_000;
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey: b64u(raw), sign: (msg: string) => b64u(edSign(null, Buffer.from(msg, "utf8"), privateKey)) };
}

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'bank', 'test-model', 'h1', 0, 0), (2, 'other', 'test-model', 'h2', 0, 0)`);
  const kv = new Map<string, string>();
  const e = { ...env, RECORDS: { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null } as unknown as KVNamespace } as Env;
  const bindKey = (citizenId: number, publicKey: string, thumbprint: string, status = "active") => {
    db.prepare("INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (?, 'Ed25519', ?, ?, 'self', ?, 0)").run(citizenId, publicKey, thumbprint, status);
  };
  return { env: e, db, bindKey, bank: { id: 1, handle: "bank" } as Citizen, other: { id: 2, handle: "other" } as Citizen };
}

async function refused(p: Promise<unknown>, status: number, re: RegExp) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SocietyError, String(e));
    assert.equal(e.status, status, e.message);
    assert.match(e.message, re);
    return true;
  });
}

const IH = "1".repeat(64);
const AH = "2".repeat(64);

test("a record with neither keeps the v1 payload", async () => {
  const { env, bank } = fixture();
  const m = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH }, T0);
  assert.equal(m.commit_payload, `1f916.mandate.v1:bank:${T0}:${IH}:${AH}:-`);
  assert.equal(m.commit_payload, commitPayload("bank", T0, IH, AH, null));
  assert.equal(m.subject, null);
  assert.equal(m.signed, false);
  const got = (await getMandate(env, m.id)) as Record<string, unknown>;
  assert.equal(got.commit_payload, m.commit_payload);
  assert.equal(await sha256Hex(got.commit_payload as string), got.commit);
  assert.equal(got.subject, null);
  assert.equal(got.signed, false);
  assert.equal(got.signed_message, null);
});

test("the subject is sealed: a different subject is a different commit", async () => {
  const { env, bank } = fixture();
  const a = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "wallet:0xAAA" }, T0);
  const sh = await sha256Hex("wallet:0xAAA");
  // Pinned as a literal, not recomputed through the module.
  assert.equal(a.commit_payload, `1f916.mandate.v2:bank:${T0}:${IH}:${AH}:-:${sh}:-`);
  assert.equal(commitPayloadV2("bank", T0, IH, AH, null, sh, null), a.commit_payload);
  assert.equal(a.commit, await sha256Hex(a.commit_payload));
  const got = (await getMandate(env, a.id)) as Record<string, unknown>;
  assert.equal(got.subject, "wallet:0xAAA");
  assert.equal(got.commit_payload, a.commit_payload, "a later read rebuilds the same payload");
  assert.equal(await sha256Hex(got.commit_payload as string), got.commit);
  // The same instant and fingerprints for another subject commit to something else.
  const { env: env2, bank: bank2 } = fixture();
  const b = await createMandate(env2, bank2, { instruction_hash: IH, action_hash: AH, subject: "wallet:0xBBB" }, T0);
  assert.notEqual(b.commit, a.commit);
});

test("the signature is sealed, verifies against a bound key, and covers the subject", async () => {
  const { env, bank, bindKey } = fixture();
  const k = keypair();
  bindKey(1, k.publicKey, "thumb-1");
  const sh = await sha256Hex("user:7f3a");
  const message = mandateSigMessage("bank", IH, AH, null, sh);
  assert.equal(message, `1f916.mandate.sig.v1:bank:${IH}:${AH}:-:${sh}`, "pinned as a literal");
  const signature = k.sign(message);
  const m = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:7f3a", signature }, T0);
  assert.equal(m.signed, true);
  assert.equal(m.key_thumbprint, "thumb-1");
  assert.equal(m.commit_payload, `1f916.mandate.v2:bank:${T0}:${IH}:${AH}:-:${sh}:${await sha256Hex(signature)}`);
  const got = (await getMandate(env, m.id)) as Record<string, unknown>;
  assert.equal(got.signature, signature);
  assert.equal(got.signed_message, message);
  assert.equal(await sha256Hex(got.commit_payload as string), got.commit);

  // The same signature is worth nothing on another subject: the message differs.
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:other", signature }, T0 + 1), 400, /does not verify/);
  // Or with no subject at all.
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature }, T0 + 2), 400, /does not verify/);
  // A signed record with no subject signs "-" in that place.
  const bare = k.sign(mandateSigMessage("bank", IH, AH, null, null));
  const s = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: bare }, T0 + 3);
  assert.equal(s.commit_payload, `1f916.mandate.v2:bank:${T0 + 3}:${IH}:${AH}:-:-:${await sha256Hex(bare)}`);
});

test("a signature that does not verify is refused, and nothing is recorded", async () => {
  const { env, db, bank, other, bindKey } = fixture();
  const mine = keypair();
  const theirs = keypair();
  bindKey(1, mine.publicKey, "thumb-mine");
  bindKey(2, theirs.publicKey, "thumb-theirs");
  const message = mandateSigMessage("bank", IH, AH, null, null);
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: theirs.sign(message) }, T0), 400, /does not verify/);
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: b64u(new Uint8Array(64)) }, T0), 400, /does not verify/);
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: "not base64url!" }, T0), 400, /base64url/);
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: b64u(new Uint8Array(10)) }, T0), 400, /64 Ed25519 bytes/);
  // A citizen with no bound key cannot sign at all.
  const { env: e2, bank: b2 } = fixture();
  await refused(createMandate(e2, b2, { instruction_hash: IH, action_hash: AH, signature: mine.sign(message) }, T0), 400, /no active bound key/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM mandates").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals").get() as { n: number }).n, 0, "and nothing was sealed");
  void other;
});

test("a revoked key no longer signs", async () => {
  const { env, bank, bindKey } = fixture();
  const k = keypair();
  bindKey(1, k.publicKey, "thumb-old", "revoked");
  await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, signature: k.sign(mandateSigMessage("bank", IH, AH, null, null)) }, T0), 400, /no active bound key/);
});

test("a subject is a short plain label", async () => {
  const { env, bank } = fixture();
  for (const bad of ["has space", "colon:ok but\nnewline", "x".repeat(129), "quote\"", "<b>", 7, { a: 1 }, ["a"]]) {
    await refused(createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: bad }, T0), 400, /subject is optional/);
  }
  for (const [i, good] of ["wallet:0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9", "user:7f3a", "x".repeat(128), "a.b-c_d"].entries()) {
    const m = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: good }, T0 + i);
    assert.equal(m.subject, good);
  }
  // Empty and absent are the same thing: no subject, v1 payload.
  const none = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "" }, T0 + 50);
  assert.equal(none.subject, null);
  assert.match(none.commit_payload, /^1f916\.mandate\.v1:/);
});

test("listing by subject returns that subject's records and nobody else's", async () => {
  const { env, bank, other } = fixture();
  const a1 = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:a" }, T0);
  const b1 = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:b" }, T0 + 1);
  const a2 = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH, subject: "user:a" }, T0 + 2);
  const plain = await createMandate(env, bank, { instruction_hash: IH, action_hash: AH }, T0 + 3);
  // Another recorder using the same label is a different subject.
  const foreign = await createMandate(env, other, { instruction_hash: IH, action_hash: AH, subject: "user:a" }, T0 + 4);
  await addOutcome(env, bank, a2.id, { outcome_hash: "9".repeat(64) }, T0 + 5);

  const ids = async (citizen: string | null, subject: string | null, since?: number) =>
    ((await listMandates(env, citizen, since, subject)).mandates as { id: number }[]).map((r) => r.id);
  assert.deepEqual(await ids("bank", "user:a"), [a1.id, a2.id]);
  assert.deepEqual(await ids("bank", "user:b"), [b1.id]);
  assert.deepEqual(await ids("bank", "user:nobody"), []);
  assert.deepEqual(await ids("other", "user:a"), [foreign.id]);
  assert.deepEqual(await ids("bank", "user:a", a1.id), [a2.id], "since_id pages within the subject");
  assert.deepEqual(await ids("bank", null), [a1.id, b1.id, a2.id, plain.id], "and without a subject the citizen's whole list is unchanged");
  const filtered = (await listMandates(env, "bank", undefined, "user:a")).mandates as { id: number; subject: string; has_outcome: boolean }[];
  assert.deepEqual(filtered.map((r) => r.subject), ["user:a", "user:a"]);
  assert.deepEqual(filtered.map((r) => r.has_outcome), [false, true], "the added outcome rides along");
});

test("a subject means something only beside its recorder", async () => {
  const { env } = fixture();
  await refused(listMandates(env, null, undefined, "user:a"), 400, /send citizen= with it/);
  await refused(listMandates(env, "bank", undefined, "bad subject"), 400, /subject is optional/);
  await refused(listMandates(env, "nobody-here", undefined, "user:a"), 404, /no citizen/);
});

test("the page and the wire carry both, and an unsigned plain record's page is unchanged", async () => {
  const { env, bank, bindKey } = fixture();
  const k = keypair();
  bindKey(1, k.publicKey, "thumb-page");
  const sh = await sha256Hex("wallet:0xabc");
  const signed = await createMandate(env, bank, { instruction: "told", action: "did", public: true, subject: "wallet:0xabc", signature: k.sign(mandateSigMessage("bank", await sha256Hex("told"), await sha256Hex("did"), null, sh)) }, T0);
  const page = await mandatePage(env, signed.id);
  assert.match(page, /Recorded for <code>wallet:0xabc<\/code>/);
  assert.match(page, /Signed by the recorder&#39;s key <code>thumb-page<\/code>|Signed by the recorder's key <code>thumb-page<\/code>/);
  assert.ok(page.includes(sealedExtras(true, true)));
  const plain = await createMandate(env, bank, { instruction: "a", action: "b", public: true }, T0 + 1);
  const plainPage = await mandatePage(env, plain.id);
  assert.doesNotMatch(plainPage, /Recorded for|Signed by the recorder|changed afterwards/);

  // Over HTTP: the query parameter is accepted, and an unknown one is still refused.
  const get = (path: string) => worker.fetch(new Request(`https://1f916.ai${path}`), env);
  const ok = await get("/api/mandates?citizen=bank&subject=wallet:0xabc");
  assert.equal(ok.status, 200);
  assert.deepEqual(((await ok.json()) as { mandates: { id: number }[] }).mandates.map((r) => r.id), [signed.id]);
  assert.equal((await get("/api/mandates?subject=wallet:0xabc")).status, 400);
  assert.equal((await get("/api/mandates?citizen=bank&subjekt=x")).status, 400);
});

test("the page says what cannot be changed, in each of the four cases", async () => {
  // The four sentences, pinned as literals. Every one that speaks of change denies it.
  assert.equal(sealedExtras(false, false), "");
  assert.equal(sealedExtras(true, false), " The same line carries the fingerprint of the label it was recorded for, so that label cannot be changed afterwards.");
  assert.equal(sealedExtras(false, true), " The same line carries the fingerprint of the recorder's signature, so that signature cannot be changed afterwards.");
  assert.equal(sealedExtras(true, true), " The same line carries the fingerprint of the label it was recorded for and the fingerprint of the recorder's signature, so neither of those can be changed afterwards.");
  for (const [a, b] of [[true, false], [false, true], [true, true]] as const) {
    assert.match(sealedExtras(a, b), /cannot be changed|neither of those can be changed/);
    assert.doesNotMatch(sealedExtras(a, b), /so (it|that label|that signature) can be changed/);
  }

  // And each case as the page actually renders it, under "Why this cannot have been changed".
  const { env, bank, bindKey } = fixture();
  const k = keypair();
  bindKey(1, k.publicKey, "thumb-cases");
  const ih = await sha256Hex("told");
  const ah = await sha256Hex("did");
  const subjectOnly = await createMandate(env, bank, { instruction: "told", action: "did", public: true, subject: "user:one" }, T0);
  const signedOnly = await createMandate(env, bank, { instruction: "told", action: "did", public: true, signature: k.sign(mandateSigMessage("bank", ih, ah, null, null)) }, T0 + 1);
  const both = await createMandate(env, bank, { instruction: "told", action: "did", public: true, subject: "user:two", signature: k.sign(mandateSigMessage("bank", ih, ah, null, await sha256Hex("user:two"))) }, T0 + 2);
  const neither = await createMandate(env, bank, { instruction: "told", action: "did", public: true }, T0 + 3);
  const esc = (t: string) => t.replace(/'/g, "&#39;");
  const cases: [number, boolean, boolean][] = [[subjectOnly.id, true, false], [signedOnly.id, false, true], [both.id, true, true], [neither.id, false, false]];
  for (const [id, hasSubject, isSigned] of cases) {
    const page = await mandatePage(env, id);
    const want = sealedExtras(hasSubject, isSigned);
    if (want) assert.ok(page.includes(want) || page.includes(esc(want)), `mandate ${id}: the page does not carry "${want.trim()}"`);
    const said = page.match(/The same line carries[^<]*/g) ?? [];
    assert.equal(said.length, want ? 1 : 0, `mandate ${id}: ${said.length} such sentences`);
    for (const sentence of said) {
      assert.doesNotMatch(sentence, /so (it|that label|that signature) can be changed/, `mandate ${id} tells the reader the record can be changed`);
      assert.match(sentence, /cannot be changed|neither of those can be changed/);
    }
  }
});
