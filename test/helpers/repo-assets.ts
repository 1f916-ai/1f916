// An ASSETS binding that serves the repository's own files under tree/, the
// way the deployed source mirror does (scripts/build-source-mirror.mjs,
// src/source-mirror.ts). For tests of code that reads a served file, such as
// the registry key rotation gate reading vendor/protocol/verify.mjs.
// `overrides` replaces a path's body; null makes it a 404.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function repoAssets(overrides: Record<string, string | null> = {}): { fetch: (input: Request | string) => Promise<Response> } {
  return {
    async fetch(input: Request | string): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input.url);
      if (!url.pathname.startsWith("/tree/")) return new Response("not found", { status: 404 });
      const path = decodeURIComponent(url.pathname.slice("/tree/".length));
      if (path in overrides) {
        const body = overrides[path];
        return body === null ? new Response("not found", { status: 404 }) : new Response(body);
      }
      const file = ROOT + path;
      if (path.includes("..") || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(readFileSync(file, "utf8"));
    },
  };
}
