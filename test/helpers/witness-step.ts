// Run the witness workflow's real `run:` step against a chain of any size.
//
// .github/workflows/witness.yml is bash and jq, and until now nothing under
// `npm test` executed it: the suite proved attest() pages (attest-coverage), and
// the step that consumes those pages was proven by reading it. This helper takes
// the step's text out of the workflow, seeds a chain through schema.sql, and runs
// the step in a scratch directory with three shims on PATH:
//
//   curl  answers /api/attest from that chain via witness-step-attest.mjs and
//         /api/checkpoint with a fixed body; refuses any other URL, and can be told
//         to fail a URL matching a substring (a fetch that died mid-run)
//   git   records the call and exits 0, or fails the first N pushes as the
//         remote did twice on 2026-09-23
//   sleep records the call and returns at once
//
// No socket is opened: the shim spawns node, never a connection. That is the
// child-process route offline.mjs names as outside its reach; it is used here to
// answer from a local file, not to reach the deployment, and the shim's refusal
// of every unshimmed URL is what makes that checkable.
//
// bash and jq are what the workflow itself needs, so a machine without them
// cannot run the step at all; the test skips with the reason rather than
// failing on a contributor's laptop. GitHub's ubuntu runners carry both.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { entryHash, GENESIS } from "../../src/chain.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCHEMA = readFileSync(join(ROOT, "schema.sql"), "utf8");
const ATTEST = join(ROOT, "test", "helpers", "witness-step-attest.mjs");
const NODE_FLAGS = ["--experimental-strip-types", "--experimental-sqlite"];

/** The live shape: identity rows 1..14 and ledger rows 1..8 predate sealing and carry no hash. */
export const LEGACY_IDENTITY = 14;
export const LEGACY_LEDGER = 8;

function runs(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

/** bash and jq, or the reason there is no step to run. */
export function tooling(): { bash: string; jq: string } | { skip: string } {
  const candidates = [process.env.WITNESS_TEST_BASH, "bash", "C:/Program Files/Git/usr/bin/bash.exe"].filter(Boolean) as string[];
  const bash = candidates.find((c) => /GNU bash/.test(runs(c, ["--version"]) ?? ""));
  if (!bash) return { skip: "GNU bash not found (the witness step is bash)" };
  const jq = runs("jq", ["--version"]) ? "jq" : null;
  if (!jq) return { skip: "jq not found (the witness step is jq)" };
  return { bash, jq };
}

/** The single `run: |` block of witness.yml, dedented. A YAML parser is not a dependency, and the file has one such block. */
export function stepScript(): string {
  const lines = readFileSync(join(ROOT, ".github", "workflows", "witness.yml"), "utf8").split("\n");
  const starts = lines.map((l, i) => (/^\s*run:\s*\|\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (starts.length !== 1) throw new Error(`expected one run: | block in witness.yml, found ${starts.length}`);
  const start = starts[0];
  const keyIndent = lines[start].match(/^\s*/)![0].length;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") {
      body.push("");
      continue;
    }
    if (l.match(/^\s*/)![0].length <= keyIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
  return body.map((l) => l.slice(indent)).join("\n") + "\n";
}

export interface ChainSpec {
  identity: number;
  ledger?: number;
  /** Rewrite this identity row's detail after sealing, leaving its stored hash: the edit-after-write attest() reports as `broken`. */
  tamper?: number;
}

/** Seed a chain to a file the attest shim can open. Hashing is the cost: ~20k rows a second. */
export async function seedChain(dir: string, spec: ChainSpec): Promise<string> {
  const path = join(dir, `chain-${spec.identity}-${spec.tamper ?? "clean"}.db`);
  if (existsSync(path)) return path;
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'seed', 'm', 'h', 100, 100)`);
  db.exec("BEGIN");
  const insI = db.prepare(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  let prev = GENESIS;
  for (let id = 1; id <= spec.identity; id++) {
    const row = { id, citizen_id: 1, kind: "joined", detail: `citizen ${id} joined`, created_at: id * 1000 };
    if (id <= LEGACY_IDENTITY) {
      insI.run(id, 1, row.kind, row.detail, row.created_at, null, null);
      continue;
    }
    const hash = await entryHash("identity_events", prev, row);
    insI.run(id, 1, row.kind, row.detail, row.created_at, prev, hash);
    prev = hash;
  }
  const insL = db.prepare(`INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  prev = GENESIS;
  for (let id = 1; id <= (spec.ledger ?? 11); id++) {
    const row = { id, entry_date: "2026-09-01", description: `entry ${id}`, amount_cents: 100 * id, created_at: id * 1000 };
    if (id <= LEGACY_LEDGER) {
      insL.run(id, row.entry_date, row.description, row.amount_cents, row.created_at, null, null);
      continue;
    }
    const hash = await entryHash("ledger", prev, row);
    insL.run(id, row.entry_date, row.description, row.amount_cents, row.created_at, prev, hash);
    prev = hash;
  }
  if (spec.tamper) db.prepare(`UPDATE identity_events SET detail = 'tampered' WHERE id = ?`).run(spec.tamper);
  db.exec("COMMIT");
  db.close();
  return path;
}

export function rowHash(dbPath: string, table: "identity_events" | "ledger", id: number): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const r = db.prepare(`SELECT hash FROM ${table} WHERE id = ?`).get(id) as { hash: string | null } | undefined;
  db.close();
  if (!r?.hash) throw new Error(`${table} row ${id} has no hash`);
  return r.hash;
}

/** A previous head line of the shape the step anchors on: heads at their positions, both logs verified. */
export function headLine(dbPath: string, identityId: number, ledgerId = 11, override: { identityHead?: string } = {}): string {
  return JSON.stringify({
    at: "2026-09-12T23:55:00Z",
    bucket: "2026-09-12T23:55",
    status: "verified",
    identity: { status: "verified", head: override.identityHead ?? rowHash(dbPath, "identity_events", identityId), verified_through_id: identityId, sealed_entries_total: 0, total_rows: 0 },
    treasury: { status: "verified", head: rowHash(dbPath, "ledger", ledgerId), verified_through_id: ledgerId, sealed_entries_total: 0, total_rows: 0 },
  });
}

export interface StepRun {
  exit: number;
  stderr: string;
  /** Every URL curl was asked for, in order. */
  urls: string[];
  /** The query strings of the /api/attest calls, "" for the bare read. */
  attestQueries: string[];
  /** The day line the step appended, parsed; {} if it wrote none. */
  line: Record<string, any>;
  git: string[];
  /** Every sleep the step asked for; the shim returns at once. */
  sleeps: string[];
}

export interface StepOptions {
  /** Contents of yesterday's day file, if the run should find an anchor. */
  yesterday?: string;
  /** curl exits 22 (what -f does on a 4xx/5xx) for any URL containing this. */
  failUrlContaining?: string;
  /** Run this text instead of the workflow's own step (for mutation checks). */
  script?: string;
  /** git push exits 1, as a remote 500 does, on its first failPushes calls. */
  failPushes?: number;
}

const CHECKPOINT = JSON.stringify({
  registry_public_key: { x: "test" },
  checkpoints: [
    { log: "identity_events", tree_size: 1, root: "r", sig: "s", created_at: 1 },
    { log: "ledger", tree_size: 3, root: "r", sig: "s", created_at: 1 },
  ],
});

/** Execute the step once, in a fresh scratch tree, against the chain at dbPath. */
export function runStep(bash: string, dbPath: string, opts: StepOptions = {}): StepRun {
  const tmp = mkdtempSync(join(tmpdir(), "witness-step-"));
  try {
    const tree = join(tmp, "tree");
    mkdirSync(join(tree, "witness"), { recursive: true });
    const today = new Date();
    const day = today.toISOString().slice(0, 10);
    const yday = new Date(today.getTime() - 86400_000).toISOString().slice(0, 10);
    if (opts.yesterday) writeFileSync(join(tree, "witness", `${yday}.jsonl`), opts.yesterday + "\n");
    const shim = join(tmp, "shim");
    mkdirSync(shim);
    const log = join(tmp, "log").replace(/\\/g, "/");
    const posix = (p: string) => p.replace(/\\/g, "/");
    // The shim: last argument is the URL, as the step spells its curl calls.
    writeFileSync(
      join(shim, "curl"),
      `#!/usr/bin/env bash
url="\${@: -1}"
printf '%s\\n' "$url" >> "${log}.curl"
if [ -n "\${STEP_FAIL_URL:-}" ] && [[ "$url" == *"$STEP_FAIL_URL"* ]]; then exit 22; fi
case "$url" in
  https://1f916.ai/api/checkpoint) printf '%s' '${CHECKPOINT}' ;;
  https://1f916.ai/api/attest|https://1f916.ai/api/attest\\?*) exec "${posix(process.execPath)}" ${NODE_FLAGS.join(" ")} "${posix(ATTEST)}" "${posix(dbPath)}" "$url" 2>/dev/null ;;
  *) echo "witness-step shim: unshimmed URL $url" >&2; exit 22 ;;
esac
`,
    );
    writeFileSync(join(shim, "git"), `#!/usr/bin/env bash\nprintf '%s\\n' "git $*" >> "${log}.git"\nexit 0\n`);
    // A remote that refuses the first failPushes pushes, as GitHub did on 2026-09-23 (c76755 on post 5095).
    if (opts.failPushes)
      writeFileSync(
        join(shim, "git"),
        `#!/usr/bin/env bash
echo "git $*" >> "${log}.git"
if [ "$1" = push ] && [ "$(grep -c "^git push" "${log}.git")" -le ${opts.failPushes} ]; then echo "remote: Internal Server Error" >&2; exit 1; fi
exit 0
`,
      );
    writeFileSync(join(shim, "sleep"), `#!/usr/bin/env bash
echo "sleep $*" >> "${log}.sleep"
`);
    for (const f of ["curl", "git", "sleep"]) chmodSync(join(shim, f), 0o755);
    writeFileSync(join(tree, ".step.sh"), opts.script ?? stepScript());
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete env.WITNESS_KEY; // the countersign block needs the society's key; the day line does not
    delete env.NODE_OPTIONS; // the child attest never opens a socket; the preload would only add startup time
    env.PATH = `${shim}${process.platform === "win32" ? ";" : ":"}${env.PATH ?? ""}`;
    env.RUNNER_TEMP = tmp;
    if (opts.failUrlContaining) env.STEP_FAIL_URL = opts.failUrlContaining;
    const r = spawnSync(bash, ["-euo", "pipefail", ".step.sh"], { cwd: tree, env, encoding: "utf8", timeout: 300_000 });
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : []);
    const urls = read(`${log}.curl`);
    const lines = read(join(tree, "witness", `${day}.jsonl`));
    return {
      exit: r.status ?? -1,
      stderr: r.stderr ?? "",
      urls,
      attestQueries: urls.filter((u) => u.includes("/api/attest")).map((u) => (u.includes("?") ? u.slice(u.indexOf("?") + 1) : "")),
      line: lines.length ? JSON.parse(lines[lines.length - 1]) : {},
      git: read(`${log}.git`),
      sleeps: read(`${log}.sleep`),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
