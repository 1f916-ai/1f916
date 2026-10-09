// Builds .source-mirror/, the static assets behind GET /source (src/source-mirror.ts).
// Wrangler runs it before every deploy and dev session (wrangler.jsonc "build").
//
// Everything comes from `git archive HEAD`, never the working tree. deploy.sh
// refuses a dirty tree and publishes HEAD as code.commit, so this is the tree
// of exactly the commit /api/official names. Copying the working tree instead
// would serve uncommitted files under that sha.
//
// Output:
//   tree/<path>         every blob in HEAD
//   manifest.json       { commit, protocol_commit, files: [[path, bytes], ...] }
//   1f916.tar.gz        git archive of HEAD
//   protocol.tar.gz     git archive of HEAD:vendor/protocol
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(ROOT, ".source-mirror");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30 });

const commit = git("rev-parse", "HEAD").toString().trim();
const protocolCommit = git("show", "HEAD:vendor/protocol.commit").toString().trim();
if (!/^[0-9a-f]{40}$/.test(protocolCommit)) throw new Error(`vendor/protocol.commit is not a full sha: ${protocolCommit}`);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "tree"), { recursive: true });
execFileSync("tar", ["-x", "-C", join(OUT, "tree")], { input: git("archive", "--format=tar", "HEAD"), maxBuffer: 1 << 30 });

// `git ls-tree -r -l -z`: "<mode> <type> <sha> <size>\t<path>\0"
const files = [];
for (const rec of git("ls-tree", "-r", "-l", "-z", "HEAD").toString().split("\0")) {
  if (!rec) continue;
  const tab = rec.indexOf("\t");
  const [mode, type, , size] = rec.slice(0, tab).trim().split(/\s+/);
  if (type !== "blob" || mode === "120000") continue;
  files.push([rec.slice(tab + 1), Number(size)]);
}
files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ commit, protocol_commit: protocolCommit, files }));

writeFileSync(join(OUT, "1f916.tar.gz"), git("archive", "--format=tar.gz", `--prefix=1f916-${commit.slice(0, 12)}/`, "HEAD"));
writeFileSync(
  join(OUT, "protocol.tar.gz"),
  git("archive", "--format=tar.gz", `--prefix=protocol-${protocolCommit.slice(0, 12)}/`, "HEAD:vendor/protocol"),
);

console.log(`source mirror: ${files.length} files from ${commit}, protocol ${protocolCommit}`);
