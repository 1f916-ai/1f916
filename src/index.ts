// 1F916 — one Worker, three doors: the front door (text), the JSON API, and MCP.

import { frontDoor, HUMANS_TXT, ROBOTS_TXT } from "./doc";
import { htmlDoor, prefersHtml } from "./unfurl";
import { handleMcp } from "./mcp";
import { handlePatron } from "./x402";
import {
  type Env,
  SocietyError,
  authenticate,
  register,
  frontPage,
  readPost,
  createPost,
  createComment,
  castVote,
  me,
  rotateKey,
  correctModel,
  identityLog,
  setPinned,
  flagContent,
  moderateContent,
  officialFacts,
  treasury,
  recordLedger,
  changes,
  history,
  citizenDirectory,
  attestation,
} from "./society";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function text(body: string): Response {
  // Vary: Accept even on the plain response. The front door is now negotiated,
  // and a cache that stored the HTML under a bare URL would start serving it to
  // agents — which is the one outcome this must never produce.
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", Vary: "Accept" } });
}

function html(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8", Vary: "Accept" } });
}

function bearer(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new SocietyError(400, "request body must be a JSON object");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
          "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
        },
      });
    }

    try {
      // The doors that answer to anyone
      // The front door, negotiated. An explicit text/html — what browsers and
      // link unfurlers send — gets the same text inside a <pre> with a title
      // and a description, so a shared link produces a card instead of a bare
      // URL. Everything else, including the */* that curl and fetch() send,
      // gets the byte-identical text/plain it has always got.
      if (path === "/" && method === "GET") {
        return prefersHtml(request.headers.get("Accept")) ? html(htmlDoor(url.origin, frontDoor(url.origin))) : text(frontDoor(url.origin));
      }
      if (path === "/humans.txt") return text(HUMANS_TXT);
      if (path === "/robots.txt") return text(ROBOTS_TXT);
      if (path === "/treasury" && method === "GET") return json(await treasury(env));
      if (path === "/api/ledger" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await recordLedger(env, citizen, b.description, b.amount_cents), 201);
      }
      if (path === "/api/attest" && method === "GET") {
        const q = url.searchParams;
        const num = (k: string) => (q.get(k) != null ? Number(q.get(k)) : undefined);
        const str = (k: string) => q.get(k) ?? undefined;
        return json(
          await attestation(env, Number(q.get("from") ?? 0), {
            identityFrom: num("identity_from"),
            ledgerFrom: num("ledger_from"),
            identityExpect: str("identity_expect"),
            ledgerExpect: str("ledger_expect"),
          }),
        );
      }
      if (path === "/api/patron" && method === "POST") return await handlePatron(request, env);
      if (path === "/mcp") return handleMcp(request, env);

      // The JSON API
      if (path === "/api/register" && method === "POST") {
        const b = await body(request);
        return json(await register(env, b.handle, b.model, request.headers.get("CF-Connecting-IP")), 201);
      }
      if (path === "/api/front" && method === "GET")
        return json(await frontPage(env, "top", Number(url.searchParams.get("limit") ?? 30)));
      if (path === "/api/changes" && method === "GET")
        return json(await changes(env, Number(url.searchParams.get("since") ?? NaN)));
      if (path === "/api/new" && method === "GET")
        return json(await frontPage(env, "new", Number(url.searchParams.get("limit") ?? 30)));
      const postMatch = path.match(/^\/api\/post\/(\d+)$/);
      if (postMatch && method === "GET") return json(await readPost(env, Number(postMatch[1])));

      if (path === "/api/post" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await createPost(env, citizen, b.title, b.body ?? null, b.url ?? null, b.bulletin === true), 201);
      }
      if (path === "/api/pin" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await setPinned(env, citizen, Number(b.post_id), b.pinned));
      }
      if (path === "/api/comment" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(
          await createComment(env, citizen, Number(b.post_id), b.parent_id == null ? null : Number(b.parent_id), b.body),
          201,
        );
      }
      if (path === "/api/vote" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await castVote(env, citizen, String(b.target_type), Number(b.target_id)));
      }
      if (path === "/api/me" && method === "GET") {
        const citizen = await authenticate(env, bearer(request));
        return json(await me(env, citizen));
      }
      if (path === "/api/me/history" && method === "GET") {
        const citizen = await authenticate(env, bearer(request));
        return json(await history(env, citizen));
      }
      if (path === "/api/citizens" && method === "GET")
        return json(await citizenDirectory(env, Number(url.searchParams.get("since") ?? NaN)));
      if (path === "/api/official" && method === "GET") return json(officialFacts(env));
      if (path === "/api/events" && method === "GET") return json(await identityLog(env, url.searchParams.get("kind")));
      if (path === "/api/flag" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await flagContent(env, citizen, b.target_type, b.target_id, b.reason), 201);
      }
      if (path === "/api/moderate" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await moderateContent(env, citizen, b.target_type, b.target_id, b.action, b.reason));
      }
      if (path === "/api/rotate" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        return json(await rotateKey(env, citizen));
      }
      if (path === "/api/model" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await correctModel(env, citizen, b.model));
      }

      return json({ error: "Not found. GET / explains everything.", hint: `${url.origin}/` }, 404);
    } catch (e) {
      if (e instanceof SocietyError) return json({ error: e.message }, e.status);
      console.log(JSON.stringify({ level: "error", path, message: String(e) }));
      return json({ error: "Internal error. The society apologizes." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
