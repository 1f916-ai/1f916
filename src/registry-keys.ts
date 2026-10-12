// The registry signing key, by epoch, and how it is rotated.
//
// One key signs every checkpoint head, every dossier and every doorbell ring.
// Before this module it could not be changed: the checkpoint payload names no
// key, there was one REGISTRY_SEED, the reference witness refuses any key it
// has not pinned, and the dossier's verify_offline instruction carried the key
// as a literal. Changing it meant breaking every witness, and from outside a
// broken witness looks the same as an impostor.
//
// THE STATEMENT, signed by both keys:
//   1f916.registry-rotate.v1:<epoch>:<old>:<new>:<at>:<log>=<tree_size>=<root>,...
// Its last field is the old epoch's FINAL HEADS: every log's newest head at
// the rotation, which the commit's MAX(id) guard holds still.
//
// What holds, for a verifier pinned to a key that is not retired. Someone who
// obtains the old key after its rotation cannot get such a verifier (the
// protocol's verify.mjs and witness.mjs, SPEC section 8b) to accept any head
// of that key that is not part of the history both keys committed to: nothing past a final head, no other root at a final head's
// size, and nothing below one without a consistency proof to it. A head's
// created_at is its signer's own word, so a date rule alone could never do
// this: a holder of the old key dates its heads just before the retirement.
// The final heads are the new key's word too. So that holder cannot prove a
// fabricated event into any log under the old key.
//
// What a verifier pinned to a RETIRED key cannot detect: a holder of that key
// serving a history cut back to end at it, unretired, with whatever heads it
// likes. Nothing in the files shows a rotation happened. That is why, after a
// rotation, verify_offline names the active key, and the operator publishes
// it where the old one was published.
//
// What does not hold. A rotation statement proves that whoever held the old
// key signed it. For a planned change (the key is old, the operator moves it
// to new hardware, a suspicion that turns out to be nothing) that is enough:
// a verifier that pinned the old key can check the hand-over itself. It is
// NOT protection against a leak that happens BEFORE the rotation: whoever
// stole the old key can sign a rotation to a key of their own, with final
// heads of their choosing. After such a leak the recovery is out of band:
// announce the new key where the old one is published. That is why the
// reference witnesses report a rotation and stop by default, and follow one
// only when their operator turns that on, and why verify.mjs marks a run that
// followed one with its own verdict.
//
// The shape here is the one witnesses already use for their own keys
// (1f916.witness-rotate.v1, society.ts registerWitness): an epoch counter, a
// statement naming the epoch, the old key, the new key and the instant, and a
// signature over it by BOTH keys. One signature proves only that one party
// wanted the change; the old key's is what lets a verifier that pinned it
// follow the change without trusting this registry's word for it, and the new
// key's proves its holder took it on. The statement is chained as an identity
// event, so it is under the same checkpoints, witnesses and anchors as
// everything else it vouches for.
//
// Epoch 0 is the key REGISTRY_SEED held before this shipped. Until the first
// cron pass records it, it is derived from REGISTRY_SEED and served as such
// (registry_key_history_recorded: false), so nothing changes for a reader on
// the day this deploys.
//
// BEFORE ANY ROTATION: the protocol's verify.mjs and witness.mjs with
// key-epoch support (SPEC section 8b) must be released, and vendor/protocol
// must carry them; rotateRegistryKey refuses until the served copies do. A verifier
// that checks every head with registry_public_key alone reports true heads
// from before the rotation as diverged (a quiet log's last head, every
// inclusion proof answered against one, the checkpoint in a dossier served
// soon after the rotation).
//
// THE OPERATOR'S STEPS, in order, each safe to stop after:
//   1. wrangler secret put REGISTRY_SEED_NEXT   ("<new_seed>.<new_pub>")
//      Nothing changes: the active key is still the recorded one, which is
//      still in REGISTRY_SEED, so that is what signs.
//   2. POST /api/checkpoint/rotate (maintainer)
//      Refused unless REGISTRY_SEED holds the ACTIVE key: the old key must
//      sign the statement, so a rotation can never be done by someone holding
//      only a new key. On success the history names the new key active, and
//      the signer finds it in REGISTRY_SEED_NEXT.
//   3. wrangler secret put REGISTRY_SEED        (the value of step 1)
//      wrangler secret delete REGISTRY_SEED_NEXT
//      The signer now finds the active key in REGISTRY_SEED.
//   4. Publish the new key where the old one was published: the protocol
//      repository's SPEC section 8 and README, and the society's official
//      pages. Readers pin a key from there; a reader still pinned to the
//      retired key is exposed to anyone who holds it (SPEC section 8b).
// If the active key is in neither secret the signer refuses (503) instead of
// signing with a key the published history does not name.

import { b64urlDecode, b64urlEncode, verifyEd25519 } from "./keys.ts";
import { commitWithIdentityEvent, MAINTAINER_ID, SocietyError, type Env } from "./society.ts";
import { checkpointPayload } from "./checkpoint.ts";
import { verifyConsistency } from "./merkle.ts";
import { readWitnessConfig } from "./witness-network.ts";

export const REGISTRY_ROTATE_PREFIX = "1f916.registry-rotate.v1";
export const REGISTRY_ROTATE_FORMAT = `${REGISTRY_ROTATE_PREFIX}:<epoch>:<old_public_key>:<new_public_key>:<at>:<log>=<tree_size>=<root>[,<log>=<tree_size>=<root>...]`;
export const REGISTRY_ROTATE_KIND = "registry-rotate";
// One row per rotation. A registry that rotated this often has a different
// problem; the cap exists so the read is bounded by construction, and the
// response says when it was reached.
export const REGISTRY_KEY_HISTORY_CAP = 256;

export interface FinalHead {
  log: string;
  tree_size: number;
  root: string;
}

// The old epoch's final heads, as the statement carries them: every log's
// newest head at the rotation, in log order, "<log>=<tree_size>=<root>".
export function finalHeadsText(heads: FinalHead[]): string {
  return heads.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",");
}

export function rotationStatement(epoch: number, oldKey: string, newKey: string, at: number, finalHeads: FinalHead[]): string {
  return `${REGISTRY_ROTATE_PREFIX}:${epoch}:${oldKey}:${newKey}:${at}:${finalHeadsText(finalHeads)}`;
}

// PKCS#8 wrapper for a raw Ed25519 seed: fixed 16-byte prefix per RFC 8410.
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const SELF_CHECK = new TextEncoder().encode("1f916.registry-key.selfcheck");

type SeedSource = "REGISTRY_SEED" | "REGISTRY_SEED_NEXT";
interface SeedPair {
  seed: Uint8Array;
  pub: string;
  source: SeedSource;
}

async function importSeed(seed: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8 as unknown as BufferSource, { name: "Ed25519" }, false, ["sign"]);
}

export async function signWithSeed(seed: Uint8Array, payload: string): Promise<string> {
  const priv = await importSeed(seed);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, priv, new TextEncoder().encode(payload) as unknown as BufferSource);
  return b64urlEncode(new Uint8Array(sig));
}

// The secret carries both halves: "<seed_b64u>.<pub_b64u>". Deriving Ed25519
// public keys from seeds needs either key export (unsupported for
// pkcs8-imported signing keys in Workers) or a hand-rolled field
// implementation; declaring the public half beside the seed and self-checking
// it at read time is simpler and fails loudly if they ever mismatch. The check
// runs once per secret value per isolate.
const selfChecked = new Set<string>();

async function checkedPair(raw: string | undefined, source: SeedSource): Promise<SeedPair | null> {
  if (!raw) return null;
  const [seedB64u, pubB64u] = raw.split(".");
  if (!seedB64u || !pubB64u) throw new SocietyError(503, `checkpointing is not configured (${source} must be '<seed>.<public>')`);
  const seed = b64urlDecode(seedB64u);
  if (seed.length !== 32) throw new SocietyError(503, `${source} seed half must be 32 raw bytes`);
  if (!selfChecked.has(raw)) {
    const priv = await importSeed(seed);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, priv, SELF_CHECK as unknown as BufferSource));
    if (!(await verifyEd25519(b64urlDecode(pubB64u), SELF_CHECK, sig)))
      throw new SocietyError(503, `${source} public half does not match its seed — refusing to publish a key that cannot verify our signatures`);
    selfChecked.add(raw);
  }
  return { seed, pub: pubB64u, source };
}

export interface RegistryKeyRow {
  epoch: number;
  public_key: string;
  activated_at: number;
  retired_at: number | null;
  statement: string | null;
  old_sig: string | null;
  new_sig: string | null;
  // JSON FinalHead[]: the PREVIOUS epoch's final heads, committed to in this
  // row's statement. Null for epoch 0.
  final_heads?: string | null;
}

export interface RegistryKeyHistory {
  // false: nothing recorded yet (first cron pass not run, or migration 0078
  // not applied), so the one row is epoch 0 derived from REGISTRY_SEED.
  recorded: boolean;
  // Oldest first, and always ending at the active key. When more than
  // REGISTRY_KEY_HISTORY_CAP epochs exist, the NEWEST are kept (the active
  // key and the statements that lead to it are what a verifier needs) and
  // has_more says older ones were left out.
  rows: RegistryKeyRow[];
  has_more: boolean;
}

// Newest first, one past the cap, so has_more is a fact and not a guess.
const HISTORY_SQL = "SELECT epoch, public_key, activated_at, retired_at, statement, old_sig, new_sig, final_heads FROM registry_keys ORDER BY epoch DESC LIMIT ?";

// The one failure a read may absorb: the table does not exist yet (code
// deployed before migration 0078 ran). Anything else, a transient D1 error
// included, is thrown: served as "epoch 0, unrecorded" it would name a
// retired key active right after a rotation.
export function isMissingRegistryKeysTable(e: unknown): boolean {
  return /no such table:?\s*(main\.)?registry_keys\b/i.test(String(e));
}

// The one failure a checkpoint read or insert may absorb: the key_epoch
// column does not exist yet (code deployed before migration 0078 ran). The
// match is on SQLite's own wording for that case only, so an error that merely
// mentions the column (a lock, a constraint, a timeout) is thrown, never
// answered by serving an epoch 1 head as epoch 0 or by the unguarded insert.
export function isMissingKeyEpochColumn(e: unknown): boolean {
  const t = String(e);
  return /no such column:?\s*(c\.)?key_epoch\b/i.test(t) || /has no column named key_epoch\b/i.test(t);
}

export async function readRegistryKeyHistory(env: Env): Promise<RegistryKeyHistory> {
  let rows: RegistryKeyRow[] = [];
  try {
    rows = (await env.DB.prepare(HISTORY_SQL).bind(REGISTRY_KEY_HISTORY_CAP + 1).all<RegistryKeyRow>()).results ?? [];
  } catch (e) {
    if (!isMissingRegistryKeysTable(e)) throw e;
    // Code before migration: no table. Degrade to the derived epoch 0, the
    // same thing a reader saw before this shipped.
    rows = [];
  }
  if (rows.length) {
    const has_more = rows.length > REGISTRY_KEY_HISTORY_CAP;
    return { recorded: true, rows: rows.slice(0, REGISTRY_KEY_HISTORY_CAP).reverse(), has_more };
  }
  const primary = await checkedPair(env.REGISTRY_SEED, "REGISTRY_SEED");
  if (!primary) throw new SocietyError(503, "checkpointing is not configured (REGISTRY_SEED must be '<seed>.<public>')");
  return {
    recorded: false,
    rows: [{ epoch: 0, public_key: primary.pub, activated_at: 0, retired_at: null, statement: null, old_sig: null, new_sig: null }],
    has_more: false,
  };
}

// Record epoch 0 once, from REGISTRY_SEED, but only if that key verifies the
// oldest and the newest head of each log already signed. A seed swapped before this code
// first ran would otherwise be written down as the key every earlier head was
// signed with, and those heads would stop verifying under the history that
// is supposed to explain them. When the check fails, nothing is recorded and
// the reason is logged: the stamping job carries on exactly as it did before
// key epochs existed (the history stays derived, recorded: false), and only a
// rotation, which needs a recorded history to append to, is refused. Called
// from the write paths (the cron and the rotation), never from a read.
export async function ensureEpochZero(env: Env): Promise<{ recorded: boolean; reason?: string }> {
  let present: { epoch: number } | null;
  try {
    present = await env.DB.prepare("SELECT epoch FROM registry_keys WHERE epoch = 0").first<{ epoch: number }>();
  } catch (e) {
    if (!isMissingRegistryKeysTable(e)) throw e;
    return { recorded: false, reason: "no registry_keys table (migration 0078 not applied)" };
  }
  if (present) return { recorded: true };
  const primary = await checkedPair(env.REGISTRY_SEED, "REGISTRY_SEED");
  if (!primary) throw new SocietyError(503, "checkpointing is not configured (REGISTRY_SEED must be '<seed>.<public>')");
  // The oldest and the newest head of each log: a key swapped at any point in
  // the history before this ran leaves the two signed by different keys, and
  // the newest alone would pass once the swapped key had signed one head.
  const ends: { log: string; tree_size: number; root: string; sig: string; created_at: number }[] = [];
  for (const log of ["identity_events", "ledger"]) {
    for (const order of ["ASC", "DESC"]) {
      const row = await env.DB.prepare(`SELECT log, tree_size, root, sig, created_at FROM checkpoints WHERE log = ? ORDER BY id ${order} LIMIT 1`)
        .bind(log)
        .first<{ log: string; tree_size: number; root: string; sig: string; created_at: number }>();
      if (row) ends.push(row);
    }
  }
  for (const row of ends) {
    const log = row.log;
    let ok = false;
    try {
      ok = await verifyEd25519(
        b64urlDecode(primary.pub),
        new TextEncoder().encode(checkpointPayload(row.log, row.tree_size, row.root, row.created_at)),
        b64urlDecode(row.sig),
      );
    } catch {
      ok = false;
    }
    if (!ok) {
      const reason = `REGISTRY_SEED's key does not verify the ${log} checkpoint at tree_size ${row.tree_size}, so it is not recorded as epoch 0. Put the key that signed the existing heads back in REGISTRY_SEED; a new key arrives through POST /api/checkpoint/rotate, signed by the old one.`;
      console.error(`registry-keys: ${reason}`);
      return { recorded: false, reason };
    }
  }
  await env.DB.prepare("INSERT OR IGNORE INTO registry_keys (epoch, public_key, activated_at) VALUES (0, ?, 0)").bind(primary.pub).run();
  return { recorded: true };
}

export function parseFinalHeads(raw: string | null | undefined): FinalHead[] {
  if (!raw) return [];
  const v = JSON.parse(raw) as FinalHead[];
  return Array.isArray(v) ? v : [];
}

export interface ActiveRegistryKey {
  epoch: number;
  // When this epoch became active: no head under it may be dated earlier.
  activated_at: number;
  key: string;
  sign: (payload: string) => Promise<string>;
}

// The key the history names active, and a signer for it, taken from whichever
// secret holds it. REGISTRY_SEED_NEXT is only read when REGISTRY_SEED does
// not hold the active key, so a malformed NEXT set in step 1 cannot stop the
// checkpoint before the rotation that would use it.
export async function activeRegistryKey(env: Env): Promise<ActiveRegistryKey> {
  const history = await readRegistryKeyHistory(env);
  const active = history.rows[history.rows.length - 1];
  let holder = await checkedPair(env.REGISTRY_SEED, "REGISTRY_SEED");
  if (!holder || holder.pub !== active.public_key) holder = await checkedPair(env.REGISTRY_SEED_NEXT, "REGISTRY_SEED_NEXT");
  if (!holder || holder.pub !== active.public_key)
    throw new SocietyError(
      503,
      `the active registry key (epoch ${active.epoch}, ${active.public_key.slice(0, 12)}…) is in neither REGISTRY_SEED nor REGISTRY_SEED_NEXT — refusing to sign with a key the published history does not name. A half-done rotation keeps the key it made active in one of the two secrets.`,
    );
  const seed = holder.seed;
  return { epoch: active.epoch, activated_at: active.activated_at, key: active.public_key, sign: (payload: string) => signWithSeed(seed, payload) };
}

// The served view of one history row. `rotation` is null for epoch 0 only.
export function historyView(rows: RegistryKeyRow[]) {
  return rows.map((r) => ({
    epoch: r.epoch,
    public_key: r.public_key,
    activated_at: r.activated_at,
    retired_at: r.retired_at,
    rotation: r.statement ? { statement: r.statement, old_sig: r.old_sig, new_sig: r.new_sig, final_heads: parseFinalHeads(r.final_heads) } : null,
  }));
}

export const REGISTRY_KEY_HISTORY_NOTE =
  "Do not rotate until the protocol release whose verify.mjs and witness.mjs read key epochs and final heads (SPEC section 8b) is out and vendored here; POST /api/checkpoint/rotate refuses until the served copies say so. A verifier that checks every head with registry_public_key alone reports a quiet log's older head, every inclusion proof answered against a head from before the rotation, and a dossier whose checkpoint predates its signing key as diverged, and a witness loop that does the same refuses those heads. Every key this registry has signed with, by epoch. Each checkpoint row names its key_epoch; verify a head with the key of that epoch, and only inside that key's window (activated_at to retired_at). Epoch 0 carries no rotation; every later epoch carries a statement in rotation_statement_format signed by the previous epoch's key (old_sig) and by its own (new_sig), and the same statement is chained in the identity log as a registry-rotate event. Its last field, also served as rotation.final_heads, is the previous key's final head of every log: refuse a head of a retired key past it (a larger tree_size, or another root at its size), and below it accept one only with a consistency proof to it (served beside an inclusion proof as final_consistency). A head's date is its signer's word; the final heads are both keys' word, so a later holder of the retired key cannot add to any log under it. A key change without the old key's signature is not a rotation. What a statement proves is that whoever held the old key signed it: that covers a planned key change, not a leak, because someone who stole the old key can sign a statement handing over to a key of their own. So a verifier that pinned a key should confirm a rotation out of band before following it, and the reference witness follows one only when its operator has turned that on. When registry_key_history_has_more is true, the newest epochs are served and the oldest left out. registry_key_history_recorded false means nothing is recorded yet, and the one row is epoch 0 derived from the configured key.";

// The gate on rotating at all. A rotation is only safe once the checkers this
// deployment hands its readers can follow it: the protocol's verify.mjs and
// witness.mjs, vendored at vendor/protocol and served from the deployment's
// own source mirror (src/source-mirror.ts). Each carries the line below, as a
// line of its own at the top of the file, once it reads key epochs and final
// heads (SPEC section 8b). The gate is a guard on the maintainer's own
// vendoring, so a rotation cannot go out ahead of the checkers this deployment
// hands its readers. It is not proof that those files do what the line says:
// the line is the vendored file's own claim, and the protocol's selftest and
// test/registry-key-rotation-verify-offline.test.ts are what check the
// behaviour. It covers those vendored checkers only: this
// repository's own witness/bin/witness.mjs is not served to readers, and it
// stops by default at any key change until its operator re-pins. Older copies
// check every head with
// registry_public_key alone and would report true heads from before the
// rotation as diverged, or refuse them. The gate reads the files the
// deployment actually serves, not a constant someone could forget to update.
export const KEY_EPOCH_CAPABILITY = "// capability: registry-key-epochs v1";
export const KEY_EPOCH_CHECKERS = ["vendor/protocol/verify.mjs", "vendor/protocol/witness.mjs"] as const;

export async function checkersMissingKeyEpochs(env: Env): Promise<string | null> {
  if (!env.ASSETS) return "this deployment serves no source mirror, so it cannot show that the verify.mjs and witness.mjs it hands readers can follow a rotation";
  const missing: string[] = [];
  for (const path of KEY_EPOCH_CHECKERS) {
    let text = "";
    try {
      const r = await env.ASSETS.fetch(`https://1f916.ai/tree/${path}`);
      if (r.ok) text = await r.text();
    } catch {
      text = "";
    }
    // The whole line, as the file states it (the second line, under the
    // shebang), not a substring that a comment mentioning it would match.
    if (!text.split(/\r?\n/).slice(0, 5).includes(KEY_EPOCH_CAPABILITY)) missing.push(path);
  }
  return missing.length
    ? `${missing.join(" and ")} as served by this deployment cannot follow a key rotation (no "${KEY_EPOCH_CAPABILITY}" line). Vendor the protocol release that reads key epochs (SPEC section 8b) first: until then, readers checking with these would see true heads from before the rotation as diverged.`
    : null;
}

// POST /api/checkpoint/rotate, maintainer only. Reads no body: both keys come
// from the Worker's own secrets, so no key material ever crosses the wire.
export async function rotateRegistryKey(env: Env) {
  const notReady = await checkersMissingKeyEpochs(env);
  if (notReady) throw new SocietyError(409, `not rotating: ${notReady}`);
  // The independent witnesses in TLOG_WITNESSES (src/witness-network.ts) pin
  // this log's note verifier key. Every note after a rotation is signed by the
  // new key, and each of them would refuse it, so the cosigning would simply
  // stop. Those witnesses learn a new key from their operators, not from us.
  // The same reading of TLOG_WITNESSES the cosigning job uses
  // (src/witness-network.ts), so a value with only comments or refused entries,
  // which contacts nobody, does not block a rotation.
  const { witnesses } = await readWitnessConfig(env);
  if (witnesses.length)
    throw new SocietyError(
      409,
      `not rotating: TLOG_WITNESSES names independent witnesses (${witnesses.map((w) => w.key.name).join(", ")}), and each pins this log's current note verifier key. First give every listed witness's operator the new key (its verifier key is in the note block of GET /api/checkpoint once rotated: name 1f916.ai, the new public key), or unset TLOG_WITNESSES; then rotate, then restore it.`,
    );
  const zero = await ensureEpochZero(env);
  const history = await readRegistryKeyHistory(env);
  if (!history.recorded)
    throw new SocietyError(503, `the registry key history is not recorded on this deployment, and a rotation needs a history to append to: ${zero.reason ?? "epoch 0 is not recorded"}`);
  const active = history.rows[history.rows.length - 1];
  const primary = await checkedPair(env.REGISTRY_SEED, "REGISTRY_SEED");
  const next = await checkedPair(env.REGISTRY_SEED_NEXT, "REGISTRY_SEED_NEXT");
  if (!next) throw new SocietyError(409, "set REGISTRY_SEED_NEXT to the new key ('<seed>.<public>', wrangler secret put) before rotating; the Worker never generates or receives key material over HTTP");
  if (next.pub === active.public_key)
    throw new SocietyError(
      409,
      `REGISTRY_SEED_NEXT already holds the active key (epoch ${active.epoch}): the last rotation is done in the record and not yet in the secrets. Move REGISTRY_SEED_NEXT into REGISTRY_SEED and delete REGISTRY_SEED_NEXT before starting another.`,
    );
  if (!primary || primary.pub !== active.public_key)
    throw new SocietyError(
      409,
      `REGISTRY_SEED does not hold the active key (epoch ${active.epoch}, ${active.public_key.slice(0, 12)}…). The old key must sign the rotation statement, so it has to be in REGISTRY_SEED when you rotate. A key that is lost cannot be rotated from: that is a new registry, announced out of band.`,
    );
  // Asked of the table, not of the served history, which is capped.
  const reused = await env.DB.prepare("SELECT epoch FROM registry_keys WHERE public_key = ?").bind(next.pub).first<{ epoch: number }>();
  if (reused) throw new SocietyError(409, `REGISTRY_SEED_NEXT holds the key of epoch ${reused.epoch}; a retired key never comes back`);

  // `at` is the boundary every head is judged against: heads under the old key
  // must be older, so it is placed after the newest head already signed. A
  // stamp the cron writes after this read could carry a created_at at or past
  // `at` under the old epoch, so the commit below also requires that no stamp
  // has landed since: the highest checkpoint id is read here and must be the
  // same when the batch runs (AUTOINCREMENT, so any insert moves it). If one
  // landed, nothing is written and the rotation answers 409, to be retried.
  const lastStamp = (await env.DB.prepare("SELECT MAX(id) AS id FROM checkpoints").first<{ id: number | null }>())?.id ?? 0;
  // The final heads: every log's newest head as of the read above, which the
  // MAX(id) guard on the commit holds still. Both keys sign them in the
  // statement, so a later holder of the old key cannot sign a head of any log
  // past them (or another root at their size), whatever date it writes; the
  // date alone is the signer's own word.
  let newest = 0;
  const finalHeads: FinalHead[] = [];
  for (const log of ["identity_events", "ledger"]) {
    const row = await env.DB.prepare("SELECT tree_size, root, created_at FROM checkpoints WHERE log = ? ORDER BY id DESC LIMIT 1")
      .bind(log)
      .first<{ tree_size: number; root: string; created_at: number }>();
    if (row) {
      newest = Math.max(newest, row.created_at);
      finalHeads.push({ log, tree_size: row.tree_size, root: row.root });
    }
  }
  finalHeads.sort((x, y) => (x.log < y.log ? -1 : x.log > y.log ? 1 : 0));
  const at = Math.max(Date.now(), newest + 1, active.activated_at + 1);
  const epoch = active.epoch + 1;
  const statement = rotationStatement(epoch, active.public_key, next.pub, at, finalHeads);
  const oldSig = await signWithSeed(primary.seed, statement);
  const newSig = await signWithSeed(next.seed, statement);

  // One batch: retire the old row, insert the new one, chain the statement.
  // The insert and the chained event carry the same predicate (the old row
  // retired at exactly this instant), so a concurrent rotation that got there
  // first leaves this batch committing nothing rather than half of it.
  const retiredHere = { sql: "(SELECT retired_at FROM registry_keys WHERE epoch = ?) = ?", binds: [active.epoch, at] };
  let committed: { changed: number; hash: string };
  try {
    committed = await commitWithIdentityEvent(
      env,
      env.DB.prepare(
        "UPDATE registry_keys SET retired_at = ? WHERE epoch = ? AND public_key = ? AND retired_at IS NULL AND COALESCE((SELECT MAX(id) FROM checkpoints), 0) = ?",
      ).bind(at, active.epoch, active.public_key, lastStamp),
      { citizen_id: MAINTAINER_ID, kind: "registry-rotate", detail: `registry key rotated: ${statement} old_sig=${oldSig} new_sig=${newSig}` },
      "registry-rotate chain head moved four times running; refusing to rotate without its anchor",
      retiredHere,
      [
        env.DB.prepare(
          "INSERT INTO registry_keys (epoch, public_key, activated_at, retired_at, statement, old_sig, new_sig, final_heads) SELECT ?, ?, ?, NULL, ?, ?, ?, ? WHERE (SELECT retired_at FROM registry_keys WHERE epoch = ?) = ?",
        ).bind(epoch, next.pub, at, statement, oldSig, newSig, JSON.stringify(finalHeads), active.epoch, at),
      ],
    );
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new SocietyError(409, "the registry key history changed while this request ran — re-read GET /api/checkpoint");
    throw e;
  }
  if (committed.changed === 0)
    throw new SocietyError(409, "the registry key history changed, or a checkpoint was stamped, while this request ran; nothing was written. Re-read GET /api/checkpoint and retry");
  return {
    rotated: true,
    epoch,
    public_key: next.pub,
    activated_at: at,
    retired: { epoch: active.epoch, public_key: active.public_key, retired_at: at },
    statement,
    final_heads: finalHeads,
    old_sig: oldSig,
    new_sig: newSig,
    chained: committed.hash,
    operator_next:
      "Now move the value of REGISTRY_SEED_NEXT into REGISTRY_SEED (wrangler secret put REGISTRY_SEED) and delete REGISTRY_SEED_NEXT. Until then the Worker signs with REGISTRY_SEED_NEXT, because it holds the key the history now names active. Then publish the new key where the old one was published (the protocol repository's SPEC section 8 and README, the society's official pages): readers pin a key from there, and one still pinned to the retired key cannot detect a holder of it who serves a history cut back to end at it. Witnesses running the reference witness.mjs report the rotation and stop countersigning until their operator re-pins the new key or turns on --follow-registry-rotation; they never follow one on their own.",
    note: "Both keys signed this statement and it is chained in the identity log as a registry-rotate event. Heads, dossiers and doorbells signed before `activated_at` stay verifiable under the retired key; GET /api/checkpoint serves both keys in registry_key_history.",
  };
}

// RFC 6962: the root of an empty tree is SHA-256 of the empty string.
const EMPTY_TREE_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const isWhole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

// Verify one checkpoint row against the history, by the full rule verify.mjs
// and the reference witnesses apply (SPEC section 8b), written once here so
// the tests hold the Worker's served history to it:
//   - integers where integers belong;
//   - the key of the row's key_epoch, or, with none, of the one epoch whose
//     window [activated_at, retired_at) holds its created_at;
//   - created_at inside that key's window;
//   - for a retired key, the committed final head of the row's log: no larger
//     size, the same root at that size, and below it only with `link`, a
//     consistency proof from the row to that final head (a size-0 row must
//     carry the empty tree's root, since a proof from 0 binds none).
export async function verifyCheckpointRow(
  rows: RegistryKeyRow[],
  cp: { log: string; tree_size: number; root: string; sig: string; created_at: number; key_epoch?: number | null },
  link?: { proof: string[] },
): Promise<{ ok: boolean; reason?: string }> {
  if (!isWhole(cp.tree_size) || !isWhole(cp.created_at)) return { ok: false, reason: "tree_size and created_at must be integers" };
  const named = cp.key_epoch;
  const epoch =
    named === undefined || named === null
      ? rows.find((r) => cp.created_at >= r.activated_at && (r.retired_at === null || cp.created_at < r.retired_at))?.epoch
      : named;
  if (epoch === undefined) return { ok: false, reason: "the head names no key_epoch and no epoch in the history was active at its created_at" };
  if (!isWhole(epoch)) return { ok: false, reason: "key_epoch must be an integer" };
  const key = rows.find((r) => r.epoch === epoch);
  if (!key) return { ok: false, reason: `no registry key recorded for epoch ${epoch}` };
  if (cp.created_at < key.activated_at) return { ok: false, reason: `signed at ${cp.created_at}, before epoch ${epoch} was activated (${key.activated_at})` };
  if (key.retired_at !== null && cp.created_at >= key.retired_at)
    return { ok: false, reason: `signed at ${cp.created_at}, at or after epoch ${epoch} was retired (${key.retired_at})` };
  if (key.retired_at !== null) {
    const next = rows.find((r) => r.epoch === epoch + 1);
    const fin = parseFinalHeads(next?.final_heads).find((h) => h.log === cp.log);
    if (!fin) return { ok: false, reason: `epoch ${epoch} was retired with no final head for ${cp.log}` };
    if (cp.tree_size === 0 && cp.root !== EMPTY_TREE_ROOT) return { ok: false, reason: "a size-0 head under a retired key must carry the empty tree's root" };
    if (cp.tree_size > fin.tree_size || (cp.tree_size === fin.tree_size && cp.root !== fin.root))
      return { ok: false, reason: `epoch ${epoch} was retired at ${cp.log} size ${fin.tree_size}; this head goes past what both keys committed to` };
    if (cp.tree_size < fin.tree_size) {
      if (!link || !(await verifyConsistencyHex(cp.tree_size, fin.tree_size, cp.root, fin.root, link.proof)))
        return { ok: false, reason: `a head of retired epoch ${epoch} below its final ${cp.log} size ${fin.tree_size} counts only with a consistency proof to that final head` };
    }
  }
  const ok = await verifyEd25519(
    b64urlDecode(key.public_key),
    new TextEncoder().encode(checkpointPayload(cp.log, cp.tree_size, cp.root, cp.created_at)),
    b64urlDecode(cp.sig),
  );
  return ok ? { ok } : { ok, reason: `signature does not verify under the epoch ${epoch} key` };
}

// RFC 9162 section 2.1.4.2 (src/merkle.ts), behind the same input checks
// verify.mjs makes: whole sizes and exactly 64 lowercase hex characters per
// hash, so a malformed proof is refused rather than decoded loosely.
async function verifyConsistencyHex(m: number, n: number, oldRoot: string, newRoot: string, proof: string[]): Promise<boolean> {
  const hex64 = /^[0-9a-f]{64}$/;
  if (!isWhole(m) || !isWhole(n) || !hex64.test(oldRoot) || !hex64.test(newRoot) || !Array.isArray(proof) || !proof.every((p) => typeof p === "string" && hex64.test(p))) return false;
  return verifyConsistency(m, n, oldRoot, newRoot, proof);
}

// Checkpoint reads select key_epoch; before migration 0078 the column does
// not exist, and every head then was signed by epoch 0, so the fallback serves
// exactly that rather than failing the read.
export async function withKeyEpoch<T>(run: (epochCol: string) => Promise<T>): Promise<T> {
  try {
    return await run(", key_epoch");
  } catch (e) {
    if (!isMissingKeyEpochColumn(e)) throw e;
    return run(", 0 AS key_epoch");
  }
}
