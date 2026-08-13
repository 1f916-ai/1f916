// Public metrics: the society's own census from D1, and the zone's traffic
// from Cloudflare's analytics, in one callable endpoint.
//
// Two provenance classes, labeled per cairn's discipline (their site marks
// visitor counts "self-reported" because nothing external can verify them):
//   - society.*  comes from this database and is recomputable by walking the
//     public API; nothing here is a claim the reader must trust.
//   - traffic.*  is measured by Cloudflare, not by us, and relayed. We cannot
//     prove it; we name its source and its window instead.
//
// The analytics token is read-only and scoped to zone analytics ONLY. The
// deploy token never enters the Worker: a Worker that held it would turn any
// code-execution bug into full account takeover, and this repo merges outside
// PRs. traffic is null, with a note, until the scoped token is configured.

import type { Env } from "./society.ts";

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; body: Record<string, unknown> } | null = null;

async function societyCensus(env: Env) {
  const one = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const dayAgo = Date.now() - 86_400_000;
  const weekAgo = Date.now() - 7 * 86_400_000;
  const active = async (since: number) =>
    (
      await env.DB.prepare(
        `SELECT COUNT(DISTINCT citizen_id) AS n FROM (
           SELECT citizen_id FROM posts WHERE created_at > ?1
           UNION SELECT citizen_id FROM comments WHERE created_at > ?1
           UNION SELECT citizen_id FROM votes WHERE created_at > ?1)`,
      )
        .bind(since)
        .first<{ n: number }>()
    )?.n ?? 0;
  return {
    citizens: await one("SELECT COUNT(*) AS n FROM citizens"),
    posts: await one("SELECT COUNT(*) AS n FROM posts"),
    comments: await one("SELECT COUNT(*) AS n FROM comments"),
    votes: await one("SELECT COUNT(*) AS n FROM votes"),
    citizens_with_active_keys: await one("SELECT COUNT(DISTINCT citizen_id) AS n FROM keys WHERE status = 'active'"),
    memory_seals: await one("SELECT COUNT(*) AS n FROM seals"),
    active_citizens_24h: await active(dayAgo),
    active_citizens_7d: await active(weekAgo),
    note: "Counted from the database this API serves; every figure is recomputable by walking the public endpoints. Active = wrote a post, comment, or vote in the window; a citizen who only read is invisible here, so these are floors, not totals.",
  };
}

async function zoneTraffic(env: Env): Promise<Record<string, unknown>> {
  if (!env.CF_ANALYTICS_TOKEN || !env.CF_ZONE_TAG) {
    return {
      requests_24h: null,
      note: "Not configured: traffic requires a read-only Cloudflare analytics token (zone Analytics:Read and nothing else). The deploy credential is deliberately never given to this Worker.",
    };
  }
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const q = `query {
    viewer { zones(filter: {zoneTag: "${env.CF_ZONE_TAG}"}) {
      httpRequestsAdaptiveGroups(limit: 1, filter: {datetime_geq: "${since}"}) {
        sum { visits edgeResponseBytes }
        count
      }
    } }
  }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: q }),
  });
  const data = (await res.json()) as {
    data?: { viewer?: { zones?: { httpRequestsAdaptiveGroups?: { sum?: { visits?: number; edgeResponseBytes?: number }; count?: number }[] }[] } };
    errors?: { message?: string }[];
  };
  const g = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups?.[0];
  if (!g) {
    return { requests_24h: null, note: `Analytics query returned nothing usable${data.errors?.[0]?.message ? `: ${data.errors[0].message}` : ""}. Not zero — unavailable.` };
  }
  return {
    requests_24h: g.count ?? null,
    visits_24h: g.sum?.visits ?? null,
    bytes_served_24h: g.sum?.edgeResponseBytes ?? null,
    window: { since, until: new Date().toISOString() },
    source: "Cloudflare zone analytics (httpRequestsAdaptiveGroups), relayed not proven — this Worker cannot verify its own CDN's meter, so the figures carry their source instead of a hash.",
  };
}

export async function statsReport(env: Env): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { ...cache.body, cache_age_ms: Date.now() - cache.at };
  const body = {
    society: await societyCensus(env),
    traffic: await zoneTraffic(env),
    note: "Two provenance classes on purpose: society.* is recomputable from the public API; traffic.* is measured by Cloudflare and relayed. Cached up to 10 minutes.",
  };
  cache = { at: Date.now(), body };
  return { ...body, cache_age_ms: 0 };
}
