// scripts/build-source-mirror.mjs: the tarballs GET /source serves can be
// rebuilt from the public repository, and the manifest hashes what was written.
//
// Run: npm test
//
// Each guarantee below names the mutation that turns it red. The script runs
// for real, against a throwaway repository, because what is being pinned is
// what `git archive` writes.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MirrorManifest } from "../src/source-mirror.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/build-source-mirror.mjs", import.meta.url));
const PROTOCOL_COMMIT = "b".repeat(40);
// NODE_OPTIONS is dropped: the suite's --import hooks resolve against this
// repository's cwd, and the script runs in the throwaway one.
const { NODE_OPTIONS: _hooks, ...inherited } = process.env;
const ENV = {
  ...inherited,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_AUTHOR_DATE: "2026-10-25T19:57:19-04:00",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_COMMITTER_DATE: "2026-10-25T19:57:19-04:00",
};
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "source-mirror-build-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: ENV });
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "vendor/protocol"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts/build-source-mirror.mjs"));
  writeFileSync(join(dir, "README.md"), "# hello\n");
  writeFileSync(join(dir, "vendor/protocol/verify.mjs"), "// checker\n");
  writeFileSync(join(dir, "vendor/protocol.commit"), `${PROTOCOL_COMMIT}\n`);
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return dir;
}

function build(dir: string): { manifest: MirrorManifest; gz: Record<string, Buffer> } {
  execFileSync(process.execPath, ["scripts/build-source-mirror.mjs"], { cwd: dir, env: ENV, stdio: "pipe" });
  const out = join(dir, ".source-mirror");
  return {
    manifest: JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as MirrorManifest,
    gz: { "1f916": readFileSync(join(out, "1f916.tar.gz")), protocol: readFileSync(join(out, "protocol.tar.gz")) },
  };
}

// Mutation: drop --mtime from the protocol archive. A tree carries no time, so
// git stamps the build clock on every entry and two builds of one commit, a
// second apart, serve different protocol tarballs.
test("two builds of one commit write byte-identical tarballs", async () => {
  const dir = repo();
  try {
    const first = build(dir);
    await new Promise((r) => setTimeout(r, 1100));
    const second = build(dir);
    for (const name of ["1f916", "protocol"]) assert.equal(sha256(second.gz[name]), sha256(first.gz[name]), `${name}.tar.gz changed between builds`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Mutation: hash something other than the written file, or record archive_args
// that differ from the ones the build ran. The printed rebuild line would then
// not reproduce the printed sha256.
test("the manifest hashes the written tarballs, and its archive_args rebuild them", () => {
  const dir = repo();
  try {
    const { manifest, gz } = build(dir);
    for (const name of ["1f916", "protocol"] as const) {
      const t = manifest.tarballs?.[name];
      assert.ok(t, `manifest has no tarballs.${name}`);
      assert.equal(t.sha256, sha256(gz[name]), `${name}: sha256 is not the written file's`);
      assert.equal(t.bytes, gz[name].length);
      const again = (format: string) => execFileSync("git", ["archive", `--format=${format}`, ...t.archive_args], { cwd: dir, env: ENV, maxBuffer: 1 << 26 });
      assert.equal(sha256(again("tar.gz")), t.sha256, `${name}: the rebuild line does not reproduce the tarball`);
      assert.equal(sha256(again("tar")), t.tar_sha256, `${name}: the tar line does not reproduce tar_sha256`);
      assert.ok(t.archive_args.every((a) => !a.includes("HEAD")), `${name}: archive_args name HEAD, which a stranger's clone does not share`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
