// A stand-in for the ASSETS binding behind GET /source (src/source-mirror.ts).
// Holds the same layout scripts/build-source-mirror.mjs writes: tree/<path>,
// manifest.json, <repo>.tar.gz. Records every path asked for, so a test can
// assert what the route did NOT fetch.

import type { MirrorManifest } from "../../src/source-mirror.ts";

export const MIRROR_COMMIT = "a".repeat(40);
export const PROTOCOL_COMMIT = "b".repeat(40);

export function fakeAssets(tree: Record<string, string | Uint8Array>, extra: Record<string, string | Uint8Array> = {}, listed?: string[]) {
  const enc = new TextEncoder();
  const bytes = (v: string | Uint8Array) => (typeof v === "string" ? enc.encode(v) : v);
  const manifest: MirrorManifest = {
    commit: MIRROR_COMMIT,
    protocol_commit: PROTOCOL_COMMIT,
    files: (listed ?? Object.keys(tree)).sort().map((p) => [p, bytes(tree[p] ?? "").length]),
  };
  const store = new Map<string, Uint8Array>();
  for (const [p, v] of Object.entries(tree)) store.set(`tree/${p}`, bytes(v));
  for (const [p, v] of Object.entries(extra)) store.set(p, bytes(v));
  store.set("manifest.json", enc.encode(JSON.stringify(manifest)));
  const asked: string[] = [];
  return {
    asked,
    manifest,
    async fetch(input: Request | string): Promise<Response> {
      const path = decodeURIComponent(new URL(typeof input === "string" ? input : input.url).pathname.slice(1));
      asked.push(path);
      const b = store.get(path);
      // Deliberately the content type a real asset store guesses from the
      // extension: the route must override it, never pass it through.
      const type = path.endsWith(".html") ? "text/html" : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream";
      return b ? new Response(b, { headers: { "Content-Type": type } }) : new Response("not found", { status: 404 });
    },
  };
}
