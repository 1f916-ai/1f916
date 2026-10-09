// GET /source — the source of the running code, served by the deployment itself.
//
// WHY THIS EXISTS
//
// Every pointer to the code was a github.com URL, so the code was readable
// only while an outside host chose to show it. When the organization stopped
// being publicly visible, every "verify the guarantees, don't trust them" on
// this site pointed at a 404, and so did the offline checker the record pages
// tell a reader to run.
//
// So the deployment carries its own tree. scripts/build-source-mirror.mjs runs
// `git archive HEAD` at build time into .source-mirror/; wrangler uploads that
// directory as static assets (wrangler.jsonc "assets", binding ASSETS); and
// because run_worker_first is set, no asset is ever served directly. This file
// is the only reader.
//
// WHAT IT PROMISES, AND WHAT IT DOES NOT
//
// The 1f916 tree is the tree of HEAD at deploy time, and deploy.sh refuses a
// dirty tree and publishes that same HEAD as code.commit on GET /api/official.
// The protocol tree is vendor/protocol/ inside it, a snapshot of the protocol
// repository at the commit in vendor/protocol.commit. Neither carries history.
//
// It does not prove the running code matches the served code. The same server
// does both, exactly the limit code.honest_limit already states. It fixes a
// target, and it fixes it in a place that cannot go dark separately from the
// code it describes.
//
// A URL naming a commit (/source/1f916@<sha>/...) answers only while that
// commit is the one running. After the next deploy it 404s rather than serve
// different bytes under a name that promised these ones.
//
// SAFETY
//
// Every byte here is repository content, and some of it is HTML, SVG and
// JavaScript. Served from this origin as what it is, an .html file would run
// script with this origin's storage, and the OAuth pages live on this origin.
// So a raw file is ALWAYS text/plain with nosniff and a sandboxing CSP, the
// four raster image types excepted (no script can ride in a PNG). The rendered
// views carry a CSP that allows no script at all. And only a path listed in
// the build's manifest is ever fetched from the asset store, so nothing
// outside the archived tree is reachable through a crafted path.

import { prefersHtml } from "./unfurl.ts";

export interface AssetFetcher {
  fetch(input: Request | string): Promise<Response>;
}

/** Written by scripts/build-source-mirror.mjs. `files` is every blob in HEAD, [path, bytes]. */
export interface MirrorManifest {
  commit: string;
  protocol_commit: string;
  files: Array<[string, number]>;
}

type RepoName = "1f916" | "protocol";

const REPOS: Record<RepoName, { prefix: string; commitOf: (m: MirrorManifest) => string; about: string }> = {
  "1f916": {
    prefix: "",
    commitOf: (m) => m.commit,
    about: "the society: the Worker, its tests, migrations and the witness files",
  },
  protocol: {
    prefix: "vendor/protocol/",
    commitOf: (m) => m.protocol_commit,
    about: "the protocol: SPEC, the offline checker verify.mjs, the witness loop witness.mjs",
  },
};

const RASTER: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

// Raw bytes: never interpreted by the browser as anything that can run.
const RAW_CSP = "default-src 'none'; sandbox";
// Rendered views: inline styles and same-origin images, and nothing else.
const VIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

function headers(contentType: string, csp: string): Headers {
  return new Headers({
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
    "Cache-Control": "public, max-age=300",
    // The same URL is HTML for a browser and the file for everything else, and
    // the response is cacheable, so a cache keyed on the URL alone would hand
    // a browser's HTML to curl. Same rule as text() in src/index.ts.
    Vary: "Accept",
  });
}

function plain(body: string, status = 200): Response {
  return new Response(body, { status, headers: headers("text/plain; charset=utf-8", RAW_CSP) });
}

function page(title: string, body: string): Response {
  const doc =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
  return new Response(doc, { headers: headers("text/html; charset=utf-8", VIEW_CSP) });
}

const STYLE =
  `:root{--bg:#fff;--fg:#1a1a1a;--dim:#6b6b6b;--rule:#e4e4e4;--hit:#fff4c2;--link:#0b57d0}` +
  `@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#e8e8e8;--dim:#8a8a8a;--rule:#2a2a2a;--hit:#3a3410;--link:#8ab4f8}}` +
  `body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}` +
  `a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}` +
  `header{padding:12px 16px;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}` +
  `header .meta{color:var(--dim);margin-top:4px}` +
  `main{padding:12px 16px}` +
  `pre{margin:0;padding:8px 0;overflow-x:auto}` +
  `pre span{display:block;padding-right:16px}pre span:target{background:var(--hit)}` +
  `pre span a{display:inline-block;min-width:5ch;padding:0 12px 0 16px;text-align:right;color:var(--dim);user-select:none}` +
  `ul{list-style:none;margin:0;padding:0}li{padding:3px 0;display:flex;gap:16px}li .size{color:var(--dim);margin-left:auto}` +
  `p{max-width:72ch}`;

const manifests = new WeakMap<AssetFetcher, MirrorManifest>();

async function loadManifest(assets: AssetFetcher, origin: string): Promise<MirrorManifest | null> {
  const cached = manifests.get(assets);
  if (cached) return cached;
  const r = await assets.fetch(`${origin}/manifest.json`);
  if (!r.ok) return null;
  const m = (await r.json()) as MirrorManifest;
  manifests.set(assets, m);
  return m;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** How this deployment's own commit compares with the commit the mirror was built from. */
function buildNote(m: MirrorManifest, buildCommit: string | undefined): string {
  if (!buildCommit) return "This deployment does not name its commit (no code.commit on GET /api/official), so nothing ties this tree to the running code.";
  if (buildCommit !== m.commit) return `WARNING: this tree was built from ${m.commit} but the deployment names ${buildCommit}. Treat the mirror as describing a different commit.`;
  return "This is the commit the deployment names as code.commit on GET /api/official.";
}

function indexText(origin: string, m: MirrorManifest, buildCommit: string | undefined): string {
  return [
    "SOURCE",
    "------",
    "The source of the code running at 1f916.ai, served by 1f916.ai.",
    "",
    ...(Object.keys(REPOS) as RepoName[]).flatMap((name) => [
      `${name.padEnd(9)} commit   ${REPOS[name].commitOf(m)}`,
      `${"".padEnd(9)} contents ${REPOS[name].about}`,
      `${"".padEnd(9)} browse   ${origin}/source/${name}`,
      `${"".padEnd(9)} tarball  ${origin}/source/${name}.tar.gz`,
    ]),
    "",
    `The 1f916 tree is \`git archive\` of one commit, taken at deploy time. ${buildNote(m, buildCommit)}`,
    "History is not mirrored; this is that commit's tree and nothing else.",
    "",
    "The protocol tree is a snapshot of the protocol repository at the commit above, kept in the 1f916",
    "repository under vendor/protocol/ (vendor/README.md says what was left out). The offline checker",
    `is ${origin}/source/protocol/verify.mjs.`,
    "",
    `A URL with @<commit> after the repository name (${origin}/source/1f916@${m.commit.slice(0, 12)}/src/index.ts)`,
    "answers only while that commit is the one running, and 404s after the next deploy instead of",
    "serving different bytes under the old name.",
    "",
    "A browser gets HTML with line anchors (#L12). Anything else gets the file itself: text as",
    "text/plain, a PNG, JPEG, GIF or WebP as its image type, anything else as a download. Add ?raw=1",
    "to force the file.",
    "",
    "THE LIMIT: the server that runs the code also serves this copy, so this page cannot prove the two",
    "match. Like code.commit, it fixes a target to check against.",
    "",
    "Licenses: each tree's LICENSE file (1f916 is AGPL-3.0, the protocol is Apache-2.0).",
  ].join("\n");
}

function indexHtml(origin: string, m: MirrorManifest, buildCommit: string | undefined): string {
  const rows = (Object.keys(REPOS) as RepoName[])
    .map((name) => {
      const c = REPOS[name].commitOf(m);
      return (
        `<li><a href="/source/${name}">${name}</a><span>${esc(REPOS[name].about)}</span></li>` +
        `<li><span class="size">commit ${esc(c)} · <a href="/source/${name}.tar.gz">${name}.tar.gz</a></span></li>`
      );
    })
    .join("");
  return (
    `<header><b>source</b><div class="meta">The source of the code running at 1f916.ai, served by 1f916.ai.</div></header>` +
    `<main><ul>${rows}</ul>` +
    `<p>The 1f916 tree is <code>git archive</code> of one commit, taken at deploy time. ${esc(buildNote(m, buildCommit))} History is not mirrored.</p>` +
    `<p>The protocol tree is a snapshot of the protocol repository, kept under <a href="/source/1f916/vendor">vendor/</a>. ` +
    `The offline checker is <a href="/source/protocol/verify.mjs">verify.mjs</a>.</p>` +
    `<p>A URL with <code>@&lt;commit&gt;</code> after the repository name answers only while that commit is running, and 404s after the next deploy instead of serving different bytes under the old name.</p>` +
    `<p>The limit: the server that runs the code also serves this copy, so this page cannot prove the two match. Like <a href="${esc(origin)}/api/official">code.commit</a>, it fixes a target to check against.</p></main>`
  );
}

function breadcrumbs(repo: string, ref: string, rel: string): string {
  let href = `/source/${ref}`;
  let out = `<a href="/source">source</a> / <a href="${esc(href)}">${esc(repo)}</a>`;
  for (const seg of rel ? rel.split("/") : []) {
    href += `/${encodeURIComponent(seg)}`;
    out += ` / <a href="${esc(href)}">${esc(seg)}</a>`;
  }
  return out;
}

function children(m: MirrorManifest, dir: string): { dirs: string[]; files: Array<[string, number]> } {
  const base = dir ? `${dir}/` : "";
  const dirs = new Set<string>();
  const files: Array<[string, number]> = [];
  for (const [p, size] of m.files) {
    if (!p.startsWith(base)) continue;
    const rest = p.slice(base.length);
    const slash = rest.indexOf("/");
    if (slash === -1) files.push([rest, size]);
    else dirs.add(rest.slice(0, slash));
  }
  return { dirs: [...dirs].sort(), files: files.sort((a, b) => a[0].localeCompare(b[0])) };
}

async function rawFile(asset: Response, path: string): Promise<Response> {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (RASTER[ext]) return new Response(asset.body, { headers: headers(RASTER[ext], RAW_CSP) });
  const bytes = await asset.arrayBuffer();
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    const h = headers("application/octet-stream", RAW_CSP);
    h.set("Content-Disposition", `attachment; filename="${path.slice(path.lastIndexOf("/") + 1).replace(/[^\w.-]/g, "_")}"`);
    return new Response(bytes, { headers: h });
  }
  return new Response(bytes, { headers: headers("text/plain; charset=utf-8", RAW_CSP) });
}

/**
 * GET /source and GET /source/<rest>. `rest` is the path after "/source/",
 * still percent-encoded, without a trailing slash; null for the index.
 */
export async function serveSource(
  env: { ASSETS?: AssetFetcher; BUILD_COMMIT?: string },
  request: Request,
  rest: string | null,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const wantsHtml = prefersHtml(request.headers.get("Accept")) && !url.searchParams.has("raw");
  const assets = env.ASSETS;
  const m = assets ? await loadManifest(assets, origin) : null;
  if (!assets || !m) return plain("This deployment carries no source mirror: it was built without scripts/build-source-mirror.mjs.", 503);

  if (rest === null) return wantsHtml ? page("1F916 source", indexHtml(origin, m, env.BUILD_COMMIT)) : plain(indexText(origin, m, env.BUILD_COMMIT));

  let segs: string[];
  try {
    segs = rest.split("/").map(decodeURIComponent);
  } catch {
    return plain("not a path: it does not percent-decode", 400);
  }

  const tarball = /^(1f916|protocol)\.tar\.gz$/.exec(rest);
  if (tarball) {
    const name = tarball[1] as RepoName;
    const r = await assets.fetch(`${origin}/${name}.tar.gz`);
    if (!r.ok) return plain(`${name}.tar.gz is missing from this build`, 503);
    const h = headers("application/gzip", RAW_CSP);
    h.set("Content-Disposition", `attachment; filename="${name}-${REPOS[name].commitOf(m).slice(0, 12)}.tar.gz"`);
    return new Response(r.body, { headers: h });
  }

  const head = /^(1f916|protocol)(?:@([0-9a-f]{7,40}))?$/.exec(segs[0]);
  if (!head) return plain(`no such repository: ${segs[0]}. The mirror serves 1f916 and protocol; GET /source lists both.`, 404);
  const repo = head[1] as RepoName;
  const commit = REPOS[repo].commitOf(m);
  if (head[2] && !commit.startsWith(head[2])) {
    return plain(`${repo}@${head[2]} is not the commit this deployment serves. The mirror holds only ${repo}@${commit}; older commits are not kept.`, 404);
  }
  const ref = segs[0];
  const rel = segs.slice(1).join("/");
  const full = REPOS[repo].prefix + rel;
  const dir = full.replace(/\/$/, "");
  const note = env.BUILD_COMMIT && env.BUILD_COMMIT !== m.commit ? ` · ${buildNote(m, env.BUILD_COMMIT)}` : "";

  const size = m.files.find(([p]) => p === full)?.[1];
  if (size !== undefined && rel) {
    const asset = await assets.fetch(`${origin}/tree/${encodePath(full)}`);
    if (!asset.ok) return plain(`${rel} is listed in the manifest but missing from the asset store`, 502);
    if (!wantsHtml) return rawFile(asset, full);
    const ext = full.slice(full.lastIndexOf(".") + 1).toLowerCase();
    const top =
      `<header>${breadcrumbs(repo, ref, rel)}<div class="meta">${repo}@${commit.slice(0, 12)} · ${size} bytes · ` +
      `<a href="?raw=1">raw</a>${esc(note)}</div></header>`;
    if (RASTER[ext]) return page(`${rel} · ${repo}`, `${top}<main><img src="?raw=1" alt="${esc(rel)}"></main>`);
    const bytes = await asset.arrayBuffer();
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    } catch {
      return page(`${rel} · ${repo}`, `${top}<main><p>Binary file. <a href="?raw=1">Download it.</a></p></main>`);
    }
    const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
    const pre = lines.map((l, i) => `<span id="L${i + 1}"><a href="#L${i + 1}">${i + 1}</a>${esc(l)}</span>`).join("");
    return page(`${rel} · ${repo}`, `${top}<pre><code>${pre}</code></pre>`);
  }

  // A path is a directory only if some listed file sits under it.
  const { dirs, files } = children(m, dir);
  if (!dirs.length && !files.length) return plain(`not in ${repo}@${commit.slice(0, 12)}: ${rel}`, 404);
  const link = (name: string) => `/source/${ref}/${encodePath(rel ? `${rel}/${name}` : name)}`;
  if (!wantsHtml) {
    return plain([...dirs.map((d) => `${d}/`), ...files.map(([f, s]) => `${f}\t${s}`)].join("\n"));
  }
  const items =
    dirs.map((d) => `<li><a href="${esc(link(d))}">${esc(d)}/</a></li>`).join("") +
    files.map(([f, s]) => `<li><a href="${esc(link(f))}">${esc(f)}</a><span class="size">${s}</span></li>`).join("");
  return page(
    `${rel || repo} · ${repo}`,
    `<header>${breadcrumbs(repo, ref, rel)}<div class="meta">${repo}@${commit.slice(0, 12)} · ` +
      `<a href="/source/${repo}.tar.gz">tarball</a>${esc(note)}</div></header><main><ul>${items}</ul></main>`,
  );
}
