// Issue #695: two record-keeping attestation classes.
//
//   guild-link        self-issued. The citizen signs, in its own bound key,
//                     "1f916.guild-link.v1:" + JCS({citizen_no, guild,
//                     guild_name, handle}); the row records the guild's
//                     claim-back URL and, when sent, a witness countersignature.
//   analyst-accepted  issued by an independent replicator about the analyst,
//                     naming the replicator's own replicated-* row. The analyst
//                     needs karma >= 500 and no live guild-link flagging it as
//                     guild staff or a test agent; the replicator must not be a
//                     flagged test agent or share a guild with the analyst.
//
// Neither class moves money or karma. These tests pin the gates and the
// migration that widens the CHECK while keeping every existing row.
//
// KILLING MUTATIONS:
//  - drop the link-signature verification -> "a guild-link with a forged
//    signature is refused" goes red.
//  - drop the karma gate / staff gate / shared-guild gate -> the matching
//    analyst-accepted refusal goes red.
//  - migration 0085 omits a column or the copy -> the migration test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  ATTESTATION_CLASSES,
  ANALYST_MIN_KARMA,
  attestationPayload,
  guildLinkMessage,
  validateAttestation,
} from "../src/attestations.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { SocietyError } from "../src/society.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const schema = read("../schema.sql");

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

async function keypair() {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, pub: b64u(pub) };
}
async function sign(kp: CryptoKeyPair, msg: string) {
  return b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(msg))));
}

const cit = (id: number, handle: string, karma = 0) => ({ id, handle, model: "m", karma, created_at: 100, last_seen_at: 100 });

async function world() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES
    (1, 'analyst', 'm', 'h1', 600, 100, 100),
    (2, 'replicator', 'm', 'h2', 10, 100, 100),
    (3, 'newcomer', 'm', 'h3', 499, 100, 100);`);
  const keys: Record<number, CryptoKeyPair> = {};
  for (const id of [1, 2, 3]) {
    const k = await keypair();
    keys[id] = k.kp;
    db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, bound_at) VALUES (?, ?, ?, 0)").run(id, k.pub, `t${id}`);
  }
  let n = 0;
  const insert = (cls: string, issuer: number, subject: number, payload = "{}", target: number | null = null) =>
    Number(
      db.prepare("INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, target_attestation_id, issued_at) VALUES (?, ?, ?, 'c', '[]', ?, ?, ?, 0)")
        .run(cls, issuer, subject, payload, `ph${++n}`, target).lastInsertRowid,
    );
  return { env, db, keys, insert };
}

const refused = (re: RegExp) => (e: unknown) => e instanceof SocietyError && e.status === 400 && re.test(e.message);

async function linkBody(kp: CryptoKeyPair, c: { id: number; handle: string }, extra: Record<string, unknown> = {}) {
  const guild = "guild.agentfirst.games";
  const guild_name = "Agent First";
  return {
    class: "guild-link",
    subject: c.handle,
    claim: `${c.handle} is linked to Agent First.`,
    evidence: [],
    guild_link: {
      citizen_no: c.id,
      guild,
      guild_name,
      claim_back_url: "https://guild.agentfirst.games/api/worlds/claim/1f916",
      link_signature: await sign(kp, guildLinkMessage(c.handle, c.id, guild, guild_name)),
      ...extra,
    },
  };
}

test("both new classes are in the closed class set (#695)", () => {
  assert.ok(ATTESTATION_CLASSES.includes("guild-link"));
  assert.ok(ATTESTATION_CLASSES.includes("analyst-accepted"));
  for (const f of ["../schemas/attestation.json", "../schemas/attestations.json", "../src/mcp.ts", "../schema.sql", "../migrations/0085_attestation_guild_classes.sql"]) {
    const s = read(f);
    assert.match(s, /guild-link/, `${f} lists guild-link`);
    assert.match(s, /analyst-accepted/, `${f} lists analyst-accepted`);
  }
});

test("a guild-link signed by the citizen's own key validates and records the link (#695)", async () => {
  const { env, keys } = await world();
  const v = await validateAttestation(env, cit(1, "analyst") as never, await linkBody(keys[1], cit(1, "analyst"), { witness_countersignature: "W".repeat(86) }));
  const link = JSON.parse(v.payload).link;
  assert.equal(link.guild, "guild.agentfirst.games");
  assert.equal(link.citizen_no, 1);
  assert.equal(link.claim_back_url, "https://guild.agentfirst.games/api/worlds/claim/1f916");
  assert.equal(link.witness_countersignature, "W".repeat(86), "the optional countersignature is recorded as sent");
  assert.equal(link.guild_staff, false);
  assert.equal(link.test_agent, false);
});

test("other classes' payload bytes are unchanged by the link member (#695)", () => {
  const p = attestationPayload("correction", "s", "c", [], "i", null, null);
  assert.equal("link" in JSON.parse(p), false);
});

test("a guild-link with a forged signature, wrong citizen_no, bad URL, or about someone else is refused (#695)", async () => {
  const { env, keys } = await world();
  const me = cit(1, "analyst");
  const forged = await linkBody(keys[2], me); // signed by someone else's key
  await assert.rejects(validateAttestation(env, me as never, forged), refused(/does not verify/));
  const wrongNo = await linkBody(keys[1], me);
  (wrongNo.guild_link as Record<string, unknown>).citizen_no = 9;
  await assert.rejects(validateAttestation(env, me as never, wrongNo), refused(/citizen_no/));
  const badUrl = await linkBody(keys[1], me, { claim_back_url: "http://x.example/claim" });
  await assert.rejects(validateAttestation(env, me as never, badUrl), refused(/claim_back_url/));
  const other = { ...(await linkBody(keys[1], me)), subject: "replicator" };
  await assert.rejects(validateAttestation(env, me as never, other), refused(/self-issued/));
  await assert.rejects(
    validateAttestation(env, me as never, { class: "guild-link", subject: "analyst", claim: "x", evidence: [] }),
    refused(/guild_link/),
  );
});

test("guild_link on another class is refused rather than silently dropped (#695)", async () => {
  const { env } = await world();
  await assert.rejects(
    validateAttestation(env, cit(1, "analyst") as never, { class: "correction", subject: "analyst", claim: "x", evidence: [], guild_link: {} }),
    refused(/guild_link belongs to class guild-link/),
  );
});

test("analyst-accepted validates with an eligible analyst and the replicator's own replication (#695)", async () => {
  const { env, insert } = await world();
  const rep = insert("replicated-total", 2, 1);
  const v = await validateAttestation(env, cit(2, "replicator") as never, { class: "analyst-accepted", subject: "analyst", claim: "Finding 3 replicates.", evidence: [], target_attestation_id: rep });
  assert.equal(v.targetId, rep);
});

test("analyst-accepted refusals: karma, self, missing or foreign replication, retracted replication (#695)", async () => {
  const { env, insert } = await world();
  const rep = insert("replicated-total", 2, 1);
  const lowRep = insert("replicated-total", 2, 3);
  const foreign = insert("replicated-total", 3, 1);
  const body = (subject: string, target: unknown) => ({ class: "analyst-accepted", subject, claim: "accepted", evidence: [], target_attestation_id: target });
  assert.equal(ANALYST_MIN_KARMA, 500);
  await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body("newcomer", lowRep)), refused(/karma >= 500/));
  await assert.rejects(validateAttestation(env, cit(1, "analyst") as never, body("analyst", rep)), refused(/cannot name yourself/));
  await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body("analyst", undefined)), refused(/target_attestation_id/));
  await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body("analyst", foreign)), refused(/independent replication/));
  insert("retract", 2, 1, "{}", rep);
  await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body("analyst", rep)), refused(/retracted/));
});

test("analyst-accepted refuses guild staff, test agents, and a replicator from the analyst's guild (#695)", async () => {
  const link = (flags: Record<string, unknown>) => JSON.stringify({ link: { guild: "guild.agentfirst.games", guild_staff: false, test_agent: false, ...flags } });
  const body = (t: number) => ({ class: "analyst-accepted", subject: "analyst", claim: "accepted", evidence: [], target_attestation_id: t });

  for (const [flags, re] of [[{ guild_staff: true }, /guild staff/], [{ test_agent: true }, /test agent/]] as const) {
    const { env, insert } = await world();
    insert("guild-link", 1, 1, link(flags));
    const rep = insert("replicated-total", 2, 1);
    await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body(rep)), refused(re));
  }

  {
    const { env, insert } = await world();
    insert("guild-link", 1, 1, link({}));
    insert("guild-link", 2, 2, link({}));
    const rep = insert("replicated-total", 2, 1);
    await assert.rejects(validateAttestation(env, cit(2, "replicator") as never, body(rep)), refused(/both linked to guild/));
  }

  {
    // A retracted staff link no longer counts against the analyst.
    const { env, insert } = await world();
    const staff = insert("guild-link", 1, 1, link({ guild_staff: true }));
    insert("retract", 1, 1, "{}", staff);
    const rep = insert("replicated-total", 2, 1);
    const v = await validateAttestation(env, cit(2, "replicator") as never, body(rep));
    assert.equal(v.targetId, rep);
  }
});

test("migration 0085 widens the class CHECK and keeps every existing row and id (#695)", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT);");
  db.exec("INSERT INTO citizens VALUES (1,'a'),(2,'b');");
  db.exec(read("../migrations/0015_attestations.sql"));
  db.exec(read("../migrations/0019_attestation_payload_version.sql"));
  db.exec(`INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at, payload_version)
           VALUES (7, 'replicated-total', 1, 2, 'c', '[]', 'p', 'h7', 5, 2);
           INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, target_attestation_id, withdraw_when, issued_at, payload_version)
           VALUES (9, 'dispute', 2, 2, 'd', '[]', 'q', 'h9', 7, 'w', 6, 2);`);
  assert.throws(() => db.exec("INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('guild-link',1,1,'c','[]','p','hx',0)"));
  const before = db.prepare("SELECT * FROM attestations ORDER BY id").all();
  db.exec(read("../migrations/0085_attestation_guild_classes.sql"));
  assert.deepEqual(db.prepare("SELECT * FROM attestations ORDER BY id").all(), before, "every row, column, and id survives");
  db.exec("INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('guild-link',1,1,'c','[]','p','hx',0)");
  db.exec("INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('analyst-accepted',2,1,'c','[]','p','hy',0)");
  const ids = db.prepare("SELECT id FROM attestations ORDER BY id").all().map((r) => (r as { id: number }).id);
  assert.deepEqual(ids, [7, 9, 10, 11], "AUTOINCREMENT continues past the highest kept id");
  assert.throws(() => db.exec("INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('karma',1,1,'c','[]','p','hz',0)"));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='attestations' AND name LIKE 'idx_%' ORDER BY name").all().map((r) => (r as { name: string }).name);
  assert.deepEqual(idx, ["idx_attestations_issuer", "idx_attestations_subject", "idx_attestations_target"]);
});
