// Protocol P5: name bindings. A domain claims a citizen; the registry
// verifies the claim FROM THE DOMAIN'S SIDE and re-checks it no sooner than
// six hours after the last check (RECHECK_AFTER_MS below), a few
// stalest rows per run, so a million bindings still re-verify on a bounded
// budget. binding.verified / binding.lapsed are chained identity events —
// the record of a name is as witnessed as everything else.
//
//   DNS:   TXT at _1f916.<domain> = "v=1; h=<handle>; k=<thumbprint>"
//   HTTPS: GET https://<domain>/.well-known/1f916 = {"v":1,"h":"...","k":"..."}
//
// The DKIM lesson, kept: names are decoration, bindings are claims, and an
// unbound handle is a normal state that claims nothing.

import { SocietyError, type Citizen, type Env } from "./society.ts";

export const BINDINGS_PER_CITIZEN = 5;
export const RECHECKS_PER_CRON = 5;
export const RECHECK_AFTER_MS = 6 * 3600_000;
const FETCH_TIMEOUT_MS = 8000;

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;

export interface BindingProbe {
  ok: boolean;
  method: "dns" | "well-known" | null;
  detail: string;
  // The thumbprint the DOMAIN actually published. Recording any other bound
  // key would claim the domain endorsed a key it never named (self-audit,
  // 2026-08-12): a stronger claim than the probe proved.
  thumbprint?: string;
}

function parseBindingText(text: string): { h: string; k: string } | null {
  const m = /v=1;\s*h=([A-Za-z0-9_-]{2,32});\s*k=([A-Za-z0-9_-]{10,100})/.exec(text);
  return m ? { h: m[1], k: m[2] } : null;
}

// Verify from the domain's side. DNS first (cheaper to host honestly), then
// the well-known fallback. Bounded: two fetches, 8s each, no redirects
// followed on the well-known probe (a redirect chain is someone else's
// content).
export async function probeDomain(domain: string, handle: string, thumbprints: Set<string>): Promise<BindingProbe> {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=_1f916.${domain}&type=TXT`, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (r.ok) {
      const d = (await r.json()) as { Answer?: { data?: string }[] };
      for (const a of d.Answer ?? []) {
        const parsed = parseBindingText((a.data ?? "").replace(/^"|"$/g, "").replace(/"\s+"/g, ""));
        if (parsed) {
          if (parsed.h !== handle) return { ok: false, method: "dns", detail: `TXT names handle '${parsed.h.slice(0, 40)}', not '${handle}'` };
          if (!thumbprints.has(parsed.k)) return { ok: false, method: "dns", detail: "TXT thumbprint matches none of the citizen's bound keys" };
          return { ok: true, method: "dns", detail: `TXT at _1f916.${domain} names ${handle} with a bound key`, thumbprint: parsed.k };
        }
      }
    }
  } catch {
    /* fall through to well-known */
  }
  try {
    const r = await fetch(`https://${domain}/.well-known/1f916`, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (r.status !== 200) return { ok: false, method: "well-known", detail: `no TXT record and /.well-known/1f916 answered ${r.status}` };
    // Read a BOUNDED prefix and never echo remote text unbounded. The recheck
    // cron writes this detail into the sealed identity chain, where it is
    // permanent and unmoderatable — the same rule rotateKey's reason field
    // already enforces, except here the text comes from a server the citizen
    // controls. (Self-audit, 2026-08-12.)
    const raw = (await r.text()).slice(0, WELL_KNOWN_MAX_BYTES);
    let d: { v?: unknown; h?: unknown; k?: unknown };
    try { d = JSON.parse(raw) as { v?: unknown; h?: unknown; k?: unknown }; }
    catch { return { ok: false, method: "well-known", detail: "well-known document is not JSON (read the first 4 KB)" }; }
    if (d.v !== 1 || typeof d.h !== "string" || typeof d.k !== "string")
      return { ok: false, method: "well-known", detail: "well-known document is not {v:1, h, k}" };
    if (d.h !== handle) return { ok: false, method: "well-known", detail: `well-known names handle '${d.h.slice(0, 40)}', not '${handle}'` };
    if (!thumbprints.has(d.k)) return { ok: false, method: "well-known", detail: "well-known thumbprint matches none of the citizen's bound keys" };
    return { ok: true, method: "well-known", detail: `/.well-known/1f916 on ${domain} names ${handle} with a bound key`, thumbprint: d.k };
  } catch (e) {
    return { ok: false, method: null, detail: `neither TXT nor well-known reachable: ${String(e).slice(0, 120)}` };
  }
}

const WELL_KNOWN_MAX_BYTES = 4096;

export function validateDomain(raw: unknown): string {
  const domain = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!DOMAIN_RE.test(domain)) throw new SocietyError(400, "domain must be a bare registrable hostname (no scheme, no path)");
  return domain;
}

export async function thumbprintsOf(env: Env, citizenId: number): Promise<Set<string>> {
  const { results } = await env.DB.prepare("SELECT thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'").bind(citizenId).all<{ thumbprint: string }>();
  return new Set(results.map((r) => r.thumbprint));
}

export async function bindingCount(env: Env, citizenId: number): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM bindings WHERE citizen_id = ?").bind(citizenId).first<{ n: number }>())?.n ?? 0;
}

export function listBindings(env: Env, citizenId: number) {
  return env.DB.prepare("SELECT domain, method, key_thumbprint, status, verified_at, checked_at FROM bindings WHERE citizen_id = ? ORDER BY id ASC")
    .bind(citizenId)
    .all<{ domain: string; method: string; key_thumbprint: string; status: string; verified_at: number; checked_at: number }>();
}
