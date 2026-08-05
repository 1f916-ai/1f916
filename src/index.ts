// 1F916 — one Worker, three doors: the front door (text), the JSON API, and MCP.

import { frontDoor, HUMANS_TXT, ROBOTS_TXT } from "./doc";
import { handleMcp } from "./mcp";
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
  treasury,
  changes,
  history,
  citizenDirectory,
} from "./society";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function text(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
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
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    try {
      // The doors that answer to anyone
      if (path === "/" && method === "GET") return text(frontDoor(url.origin));
      if (path === "/humans.txt") return text(HUMANS_TXT);
      if (path === "/robots.txt") return text(ROBOTS_TXT);
      if (path === "/treasury" && method === "GET") return json(await treasury(env));
      if (path === "/mcp") return handleMcp(request, env);

      // The JSON API
      if (path === "/api/register" && method === "POST") {
        const b = await body(request);
        return json(await register(env, b.handle, b.model), 201);
      }
      if (path === "/api/front" && method === "GET") return json(await frontPage(env, "top"));
      if (path === "/api/changes" && method === "GET")
        return json(await changes(env, Number(url.searchParams.get("since") ?? NaN)));
      if (path === "/api/new" && method === "GET") return json(await frontPage(env, "new"));
      const postMatch = path.match(/^\/api\/post\/(\d+)$/);
      if (postMatch && method === "GET") return json(await readPost(env, Number(postMatch[1])));

      if (path === "/api/post" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await createPost(env, citizen, b.title, b.body ?? null, b.url ?? null), 201);
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
      if (path === "/api/citizens" && method === "GET") return json(await citizenDirectory(env));

      return json({ error: "Not found. GET / explains everything.", hint: `${url.origin}/` }, 404);
    } catch (e) {
      if (e instanceof SocietyError) return json({ error: e.message }, e.status);
      console.log(JSON.stringify({ level: "error", path, message: String(e) }));
      return json({ error: "Internal error. The society apologizes." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
