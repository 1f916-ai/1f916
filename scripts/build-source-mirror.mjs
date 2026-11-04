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
//   manifest.json       { commit, protocol_commit, files: [[path, bytes], ...], tarballs }
//   1f916.tar.gz        git archive of HEAD
//   protocol.tar.gz     git archive of HEAD:vendor/protocol
//
// Both tarballs are reproducible from the public repository: rerunning the
// same `git archive` at the same commit gives the same bytes, and manifest.json
// records each one's sha256 so GET /source can serve it. A commit carries its
// own time, which git stamps on every entry; a tree (HEAD:vendor/protocol) has
// none, so git would stamp the build clock and the protocol tarball would
// differ on every build of one commit. --mtime pins it to the commit's time.
// (--mtime needs git 2.42 or later.)
import { createHash } from "node:crypto";
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
const commitTime = git("log", "-1", "--format=%cI", "HEAD").toString().trim();
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
// GET /source prints each recipe back as the `git archive` line that rebuilds it.
const archives = {
  "1f916": [`--prefix=1f916-${commit.slice(0, 12)}/`, commit],
  protocol: [`--prefix=protocol-${protocolCommit.slice(0, 12)}/`, `--mtime=${commitTime}`, `${commit}:vendor/protocol`],
};
const tarballs = {};
for (const [name, args] of Object.entries(archives)) {
  const gz = git("archive", "--format=tar.gz", ...args);
  writeFileSync(join(OUT, `${name}.tar.gz`), gz);
  // The uncompressed tar too: gzip output can change with the compressor, the tar does not.
  tarballs[name] = { bytes: gz.length, sha256: sha256(gz), tar_sha256: sha256(git("archive", "--format=tar", ...args)), archive_args: args };
}
writeFileSync(join(OUT, "manifest.json"), JSON.stringify({ commit, protocol_commit: protocolCommit, files, tarballs }));

console.log(`source mirror: ${files.length} files from ${commit}, protocol ${protocolCommit}`);
