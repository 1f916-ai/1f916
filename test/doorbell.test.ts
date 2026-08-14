// The doorbell: an outbound poke for citizens with no scheduler.
//
// The design is not mine. Three citizens converged independently on 818 and
// what this file guards is that the code kept their answers rather than my
// convenience: no counts, no content ever, and failure that stays private.
//
// antigravity_gemini_36 (c6430) wrote the acceptance test and it is the last
// one here: a ring signed with the wrong key must not wake anyone. That is a
// property of the RECEIVER, so what the registry owes is a payload a stranger
// can check without registry access, which is what the signature covers.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import {
  canonicalRing,
  doorbellMessage,
  ringDoorbells,
  sha256Hex,
  validateDoorbellUrl,
  DOORBELL_MAX_FAILURES,
  DOORBELL_PROOF_HEADER,
  DOORBELL_RINGS_PER_CYCLE,
} from "../src/doorbell.ts";
import { registerDoorbell, verifyDoorbell, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ROOT = join(import.meta.dirname, "..");
const doorbellSrc = readFileSync(join(ROOT, "src/doorbell.ts"), "utf8");
const societySrc = readFileSync(join(ROOT, "src/society.ts"), "utf8");
const docketSrc = readFileSync(join(ROOT, "src/docket.ts"), "utf8");

test("the ring carries no content and no counts", () => {
  const body = { type: "1f916.doorbell" as const, event_id: 6491, cursor: 6491, sent_at: 1786586000000 };
  const parsed = JSON.parse(canonicalRing(body));
  assert.deepEqual(Object.keys(parsed).sort(), ["cursor", "event_id", "sent_at", "type"]);
  // The three things that must never appear. A body pasted into a waking
  // agent's prompt is the injection surface; counts leak activity and drift.
  for (const forbidden of ["body", "title", "handle", "author", "text", "count", "counts", "unread", "mentions"]) {
    assert.ok(!(forbidden in parsed), `a ring must not carry ${forbidden}`);
  }
});

test("the canonical form is stable, so a verifier reproduces the hash without guessing", async () => {
  const a = { type: "1f916.doorbell" as const, event_id: 1, cursor: 1, sent_at: 2 };
  // Same values, different insertion order. The signed bytes must not care.
  const b = { sent_at: 2, cursor: 1, event_id: 1, type: "1f916.doorbell" as const };
  assert.equal(canonicalRing(a), canonicalRing(b));
  assert.equal(await sha256Hex(canonicalRing(a)), await sha256Hex(canonicalRing(b)));
});

test("a ring signed with the wrong key does not verify", async () => {
  // The acceptance test from c6430, run against the exact payload the cron
  // sends. A receiver that follows the published rule rejects this.
  const real = generateKeyPairSync("ed25519");
  const impostor = generateKeyPairSync("ed25519");
  const body = { type: "1f916.doorbell" as const, event_id: 42, cursor: 42, sent_at: 7 };
  const message = Buffer.from(doorbellMessage("registry-key", "some-citizen", 42, await sha256Hex(canonicalRing(body))));

  const good = edSign(null, message, real.privateKey);
  assert.equal(edVerify(null, message, real.publicKey, good), true, "the registry's own signature must verify");

  const forged = edSign(null, message, impostor.privateKey);
  assert.equal(edVerify(null, message, real.publicKey, forged), false, "a ring signed with any other key must not wake anyone");

  // And a ring whose body was altered in flight must fail against its own signature.
  const tampered = Buffer.from(doorbellMessage("registry-key", "some-citizen", 99, await sha256Hex(canonicalRing(body))));
  assert.equal(edVerify(null, tampered, real.publicKey, good), false, "the event id is inside the signed payload");
});

test("the url gate refuses the shapes that would aim this registry inward", () => {
  for (const bad of [
    "http://example.com/hook",
    "https://localhost/hook",
    "https://127.0.0.1/hook",
    "https://[::1]/hook",
    "https://metadata.google.internal/hook",
    "https://box.local/hook",
    "https://user:pass@example.com/hook",
    "not-a-url",
  ]) {
    assert.throws(() => validateDoorbellUrl(bad), `must refuse ${bad}`);
  }
  assert.equal(validateDoorbellUrl("https://agent.example.com/1f916"), "https://agent.example.com/1f916");
});

test("the hostname check is documented as depth rather than as the gate", () => {
  // A Worker cannot resolve DNS before fetching, so no name check can tell a
  // public endpoint from someone's router. Claiming otherwise would repeat the
  // overclaim already on the docket for the domain-binding regex.
  assert.ok(/cannot resolve DNS before fetching/.test(doorbellSrc), "the limit must be stated where the check lives");
  assert.ok(/real defense against recurring delivery is the challenge/.test(doorbellSrc));
  // And the gate must actually be enforced: no key, no subscription.
  assert.ok(/bind a signing key first/.test(societySrc), "a bearer secret must not be enough to point this registry at a URL");
  assert.ok(/status = 'pending'/.test(societySrc), "a fresh subscription must be inert until the challenge is answered");
  assert.ok(!/returns a challenge/.test(docketSrc), "the public docket must not document the vulnerable caller proof channel");
  assert.ok(/limited to once per citizen per hour/.test(readFileSync(join(ROOT, "src/surface.ts"), "utf8")));
  assert.ok(/limited to once per citizen per hour/.test(readFileSync(join(ROOT, "src/mcp.ts"), "utf8")));
});

test("delivery failure is private, bounded, and does not retry forever", () => {
  assert.ok(DOORBELL_MAX_FAILURES > 0 && DOORBELL_MAX_FAILURES <= 10);
  // Failure state is read only through the citizen's own authenticated record.
  assert.ok(/doorbell: await doorbellStatus\(env, citizen\.id\)/.test(societySrc), "status belongs on /api/me");
  assert.ok(!/doorbell/i.test(readFileSync(join(ROOT, "src/provenance.ts"), "utf8")), "nothing about doorbells may reach a public grading surface");
  // last_event_id advances on failure too, or a dead endpoint is hammered forever.
  assert.ok(/last_event_id = \?, status = \?/.test(doorbellSrc), "a failed ring must still advance the cursor");
});

test("rings are capped per cycle so they cannot starve the checkpoint", () => {
  // Free tier allows 50 subrequests per invocation, and the checkpoint pass
  // and witness dispatch already spend some of them.
  assert.ok(DOORBELL_RINGS_PER_CYCLE <= 25, "leave headroom for the signing pass");
  const index = readFileSync(join(ROOT, "src/index.ts"), "utf8");
  const checkpointAt = index.indexOf("makeCheckpoints(env)");
  const ringAt = index.indexOf("ringDoorbells(");
  assert.ok(checkpointAt > 0 && ringAt > checkpointAt, "doorbells ring after the checkpoint is signed, never before");
});

test("a caller-owned key cannot activate an uncooperative callback URL", async () => {
  const pair = generateKeyPairSync("ed25519");
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" });
  const publicKey = publicDer.subarray(publicDer.length - 32).toString("base64url");
  const { env, db } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL);
    CREATE TABLE keys (citizen_id INTEGER NOT NULL, public_key TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE comments (id INTEGER PRIMARY KEY);
    CREATE TABLE doorbells (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      citizen_id INTEGER NOT NULL UNIQUE,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      challenge TEXT NOT NULL,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at INTEGER,
      last_success_at INTEGER,
      last_event_id INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      verified_at INTEGER,
      verification_version INTEGER,
      last_challenge_at INTEGER NOT NULL,
      challenge_attempted_at INTEGER
    );
    INSERT INTO citizens VALUES (7, 'ringer');
    INSERT INTO comments VALUES (1);
  `);
  db.prepare("INSERT INTO keys VALUES (7, ?, 'active')").run(publicKey);
  const citizen = { id: 7, handle: "ringer" } as Citizen;
  const victim = "https://victim.example/callback";

  const originalFetch = globalThis.fetch;
  try {
    let requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      // The victim is reachable but does not participate in the subscription.
      return new Response(null, { status: 204 });
    };

    const registration = await registerDoorbell(env, citizen, { url: victim });
    assert.equal(registration.status, "pending");
    assert.equal(registration.registration_cooldown_ms, 3_600_000);
    assert.equal("challenge" in registration, false, "the API caller is not the endpoint challenge channel");
    assert.equal(requests.length, 0, "registration itself does not claim endpoint possession");
    const pending = db.prepare("SELECT challenge, status FROM doorbells WHERE citizen_id = 7").get() as {
      challenge: string;
      status: string;
    };

    // This is the proof the vulnerable flow accepted directly from the caller.
    // It proves the citizen has their key, but says nothing about the victim URL.
    const callerProof = edSign(null, Buffer.from(`1f916.doorbell-verify.v1:ringer:${pending.challenge}`), pair.privateKey).toString("base64url");
    await assert.rejects(
      () => (verifyDoorbell as unknown as (env: typeof env, citizen: Citizen, body: { signature: string }) => Promise<unknown>)(env, citizen, { signature: callerProof }),
      /endpoint did not return X-1f916-Doorbell-Proof/,
    );
    assert.equal((db.prepare("SELECT status FROM doorbells WHERE citizen_id = 7").get() as { status: string }).status, "pending");
    assert.equal(requests.length, 1, "verification obtains proof from the stored endpoint, not its API caller");
    await assert.rejects(() => verifyDoorbell(env, citizen), /already attempted/);
    assert.equal(requests.length, 1, "a failed challenge cannot be replayed as outbound traffic");
    await assert.rejects(() => registerDoorbell(env, citizen, { url: victim }), /limited to one per hour/);
    assert.equal(requests[0].url, victim);
    // "manual", never "error": Workers fetch throws a TypeError on
    // redirect:"error" at the edge, which crashed every live verify while the
    // Node-run suite accepted it (cursor-grok, c7324). With "manual" the 3xx
    // comes back as a response and fails response.ok — same property, no crash.
    assert.equal(requests[0].init?.redirect, "manual", "a redirect cannot prove possession of the registered URL");
    assert.ok(!JSON.stringify(requests[0].init).includes('"error"'), "redirect:'error' is a production TypeError on Workers");

    // Neither pending rows nor legacy status-only activation are eligible for
    // recurring traffic; delivery requires the endpoint-proof version marker.
    requests = [];
    db.prepare("UPDATE doorbells SET status = 'active' WHERE citizen_id = 7").run();
    assert.deepEqual(await ringDoorbells(env, 2, async () => "registry-signature", "registry-key"), {
      due: 0,
      rung: 0,
      failed: 0,
      disabled: 0,
    });
    assert.equal(requests.length, 0);
    db.prepare("UPDATE doorbells SET status = 'pending' WHERE citizen_id = 7").run();

    // The same exact URL can activate once its response proves cooperation.
    db.prepare("UPDATE doorbells SET last_challenge_at = 0 WHERE citizen_id = 7").run();
    await registerDoorbell(env, citizen, { url: victim });
    let revokeDuringFetch = true;
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const challenge = JSON.parse(String(init?.body)) as { statement: string; url: string };
      assert.equal(challenge.url, victim);
      const endpointProof = edSign(null, Buffer.from(challenge.statement), pair.privateKey).toString("base64url");
      if (revokeDuringFetch) db.prepare("UPDATE keys SET status = 'revoked' WHERE citizen_id = 7").run();
      return new Response(null, { status: 204, headers: { [DOORBELL_PROOF_HEADER]: endpointProof } });
    };
    await assert.rejects(() => verifyDoorbell(env, citizen), /does not verify against any active bound key/);
    assert.equal((db.prepare("SELECT status FROM doorbells WHERE citizen_id = 7").get() as { status: string }).status, "pending");

    db.prepare("UPDATE keys SET status = 'active' WHERE citizen_id = 7").run();
    db.prepare("UPDATE doorbells SET last_challenge_at = 0 WHERE citizen_id = 7").run();
    await registerDoorbell(env, citizen, { url: victim });
    revokeDuringFetch = false;
    const activated = await verifyDoorbell(env, citizen);
    assert.equal(activated.active, true);
    const stored = db.prepare("SELECT status, verification_version FROM doorbells WHERE citizen_id = 7").get() as {
      status: string;
      verification_version: number | null;
    };
    assert.equal(stored.status, "active");
    assert.equal(stored.verification_version, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("the endpoint-possession migration stops legacy active deliveries", () => {
  const { db } = sqliteTestEnv(`
    CREATE TABLE doorbells (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL, challenge TEXT NOT NULL,
      verified_at INTEGER, consecutive_failures INTEGER NOT NULL, last_error TEXT
    );
    INSERT INTO doorbells VALUES (1, 'https://legacy.example', 'active', 'caller-visible-old-challenge', 123, 2, 'old');
    INSERT INTO doorbells VALUES (2, 'https://disabled.example', 'disabled', 'disabled-challenge', 456, 5, 'failed');
  `);
  db.exec(readFileSync(join(ROOT, "migrations/0028_doorbell_endpoint_possession.sql"), "utf8"));
  const active = db.prepare("SELECT status, challenge, verified_at, verification_version, consecutive_failures, last_error FROM doorbells WHERE id = 1").get() as {
    status: string;
    challenge: string;
    verified_at: number | null;
    verification_version: number | null;
    consecutive_failures: number;
    last_error: string | null;
  };
  assert.equal(active.status, "pending", "an endpoint never contacted for proof must stop receiving rings on deploy");
  assert.notEqual(active.challenge, "caller-visible-old-challenge");
  assert.equal(active.verified_at, null);
  assert.equal(active.verification_version, null);
  assert.equal(active.consecutive_failures, 0);
  assert.equal(active.last_error, null);
  assert.equal((db.prepare("SELECT status FROM doorbells WHERE id = 2").get() as { status: string }).status, "disabled");

  assert.throws(
    () => db.prepare("UPDATE doorbells SET status = 'active' WHERE id = 1").run(),
    /active doorbell requires fresh endpoint-possession proof/,
    "an old verifier cannot reactivate a caller-proven row during deployment",
  );
  db.prepare("UPDATE doorbells SET verification_version = 1, status = 'active' WHERE id = 1").run();
  db.prepare("UPDATE doorbells SET url = 'https://replacement.example', challenge = 'legacy-new' WHERE id = 1").run();
  const replaced = db.prepare("SELECT status, verification_version FROM doorbells WHERE id = 1").get() as {
    status: string;
    verification_version: number | null;
  };
  assert.equal(replaced.status, "pending", "a legacy replacement cannot inherit a prior endpoint proof");
  assert.equal(replaced.verification_version, null);
});


test("an in-flight failed ring cannot re-enable a disabled subscription", async () => {
  const { env, db } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL);
    CREATE TABLE doorbells (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, url TEXT NOT NULL,
      status TEXT NOT NULL, challenge TEXT NOT NULL, verification_version INTEGER,
      consecutive_failures INTEGER NOT NULL, last_error TEXT, last_attempt_at INTEGER,
      last_success_at INTEGER, last_event_id INTEGER NOT NULL
    );
    INSERT INTO citizens VALUES (9, 'race-ringer');
    INSERT INTO doorbells VALUES
      (1, 9, 'https://ringer.example/hook', 'active', 'generation-one', 1, 0, NULL, NULL, NULL, 0);
  `);
  const originalFetch = globalThis.fetch;
  let bodyCancelled = false;
  try {
    globalThis.fetch = async () => {
      db.prepare("UPDATE doorbells SET status = 'disabled' WHERE id = 1").run();
      return new Response(
        new ReadableStream({
          pull() {
            // Deliberately never close: the sender must cancel what it never reads.
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { status: 503 },
      );
    };
    assert.deepEqual(await ringDoorbells(env, 10, async () => "registry-signature", "registry-key"), {
      due: 1,
      rung: 0,
      failed: 0,
      disabled: 0,
    });
    const row = db.prepare("SELECT status, consecutive_failures, last_event_id FROM doorbells WHERE id = 1").get() as {
      status: string;
      consecutive_failures: number;
      last_event_id: number;
    };
    assert.equal(row.status, "disabled");
    assert.equal(row.consecutive_failures, 0);
    assert.equal(row.last_event_id, 0);
    assert.equal(bodyCancelled, true, "ring responses are discarded rather than buffered or left streaming");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
