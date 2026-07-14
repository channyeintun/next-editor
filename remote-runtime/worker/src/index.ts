import { bearer, signToken, verifyToken } from "./auth";
import { RuntimeGoSessionDO } from "./sessionDo";
import type { Env, SessionRecord } from "./types";

export { RuntimeGoSessionDO };

const jsonHeaders = { "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: jsonHeaders });

async function authenticated(request: Request, env: Env) {
  return verifyToken(env.RUNTIME_SESSION_SECRET, bearer(request));
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.RUNTIME_GO_SESSIONS.get(env.RUNTIME_GO_SESSIONS.idFromName(sessionId));
}

async function sessionRecord(env: Env, sessionId: string): Promise<SessionRecord | null> {
  const row = await env.RUNTIME_QUOTAS.prepare(
    "SELECT session_id, user_id, runtime, created_at FROM runtime_sessions WHERE session_id = ? AND ended_at IS NULL",
  ).bind(sessionId).first<{ session_id: string; user_id: string; runtime: "go1.26.5"; created_at: number }>();
  return row && { sessionId: row.session_id, userId: row.user_id, runtime: row.runtime, createdAt: row.created_at };
}

async function authorizeSession(request: Request, env: Env, sessionId: string): Promise<SessionRecord> {
  const queryToken = new URL(request.url).searchParams.get("token");
  const claims = await verifyToken(env.RUNTIME_SESSION_SECRET, queryToken ?? bearer(request));
  if (claims.sessionId !== sessionId) throw new Error("token does not match session");
  const record = await sessionRecord(env, sessionId);
  if (!record || record.userId !== claims.userId) throw new Error("session not found");
  return record;
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const claims = await authenticated(request, env);
  const body = await request.json<{ runtime?: string; workdirName?: string; idleTimeoutSeconds?: number }>();
  if ((body.runtime ?? "go1.26.5") !== "go1.26.5") return json({ code: "ERUNTIME", message: "Only go1.26.5 is enabled" }, 400);
  const maxConcurrent = Number(env.MAX_CONCURRENT_SESSIONS || 2);
  const active = await env.RUNTIME_QUOTAS.prepare(
    "SELECT COUNT(*) AS count FROM runtime_sessions WHERE user_id = ? AND ended_at IS NULL",
  ).bind(claims.userId).first<{ count: number }>();
  if ((active?.count ?? 0) >= maxConcurrent) return json({ code: "EQUOTA", message: "Concurrent runtime limit reached" }, 429);
  const day = new Date().toISOString().slice(0, 10);
  const usage = await env.RUNTIME_QUOTAS.prepare(
    "SELECT minutes FROM runtime_daily_usage WHERE user_id = ? AND day = ?",
  ).bind(claims.userId, day).first<{ minutes: number }>();
  if ((usage?.minutes ?? 0) >= Number(env.MAX_DAILY_MINUTES || 120)) {
    return json({ code: "EQUOTA", message: "Daily runtime minutes exhausted" }, 429);
  }

  const sessionId = crypto.randomUUID();
  const createdAt = Date.now();
  await env.RUNTIME_QUOTAS.prepare(
    "INSERT INTO runtime_sessions (session_id, user_id, runtime, created_at) VALUES (?, ?, 'go1.26.5', ?)",
  ).bind(sessionId, claims.userId, createdAt).run();
  const token = await signToken(env.RUNTIME_SESSION_SECRET, {
    userId: claims.userId, sessionId, exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const origin = new URL(request.url);
  const wsProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${origin.host}/api/runtime/sessions/${sessionId}/ws`;
  return json({
    sessionId, token, wsUrl,
    previewUrlTemplate: env.PREVIEW_URL_TEMPLATE.replaceAll("{{sessionId}}", sessionId),
  }, 201);
}

async function closeSession(request: Request, env: Env, sessionId: string): Promise<Response> {
  const record = await authorizeSession(request, env, sessionId);
  const response = await sessionStub(env, sessionId).fetch(new Request("http://do/__runtime/destroy", { method: "DELETE" }));
  const endedAt = Date.now();
  const minutes = Math.max(1, Math.ceil((endedAt - record.createdAt) / 60_000));
  const day = new Date(endedAt).toISOString().slice(0, 10);
  await env.RUNTIME_QUOTAS.batch([
    env.RUNTIME_QUOTAS.prepare("UPDATE runtime_sessions SET ended_at = ? WHERE session_id = ?").bind(endedAt, sessionId),
    env.RUNTIME_QUOTAS.prepare(`INSERT INTO runtime_daily_usage (user_id, day, minutes) VALUES (?, ?, ?)
      ON CONFLICT(user_id, day) DO UPDATE SET minutes = minutes + excluded.minutes`).bind(record.userId, day, minutes),
  ]);
  return response;
}

async function apiRoute(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/sessions" && request.method === "POST") return createSession(request, env);
  const match = path.match(/^\/sessions\/([0-9a-f-]+)\/(ws|preview-script)$/);
  if (match) {
    const [, sessionId, action] = match;
    await authorizeSession(request, env, sessionId!);
    if (action === "ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
      return sessionStub(env, sessionId!).fetch(new Request("http://do/ws", request));
    }
    if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
    return sessionStub(env, sessionId!).fetch(new Request("http://do/__runtime/preview-script", request));
  }
  const deletion = path.match(/^\/sessions\/([0-9a-f-]+)$/);
  if (deletion && request.method === "DELETE") return closeSession(request, env, deletion[1]!);
  return new Response("Not found", { status: 404 });
}

function previewTarget(request: Request): { sessionId: string; port: number; path: string } | null {
  const url = new URL(request.url);
  const pathMatch = url.pathname.match(/^\/preview\/([0-9a-f-]+)\/(\d+)(\/.*)?$/);
  if (pathMatch) return { sessionId: pathMatch[1]!, port: Number(pathMatch[2]), path: pathMatch[3] ?? "/" };
  const hostMatch = url.hostname.match(/^p(\d+)-([0-9a-f-]+)(?:\.|-preview\.)/);
  if (hostMatch) return { sessionId: hostMatch[2]!, port: Number(hostMatch[1]), path: url.pathname };
  return null;
}

async function preview(request: Request, env: Env, target: NonNullable<ReturnType<typeof previewTarget>>): Promise<Response> {
  if (target.port < 1 || target.port > 65535 || !(await sessionRecord(env, target.sessionId))) return new Response("Not found", { status: 404 });
  const headers = new Headers(request.headers); headers.delete("Cookie"); headers.delete("Authorization");
  const url = new URL(request.url);
  const internal = new URL(`/__runtime/preview/${target.port}${target.path}${url.search}`, "http://do");
  return sessionStub(env, target.sessionId).fetch(new Request(internal, { method: request.method, headers, body: request.body, redirect: "manual" }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/runtime")) return await apiRoute(request, env, url.pathname.slice("/api/runtime".length));
      const target = previewTarget(request);
      if (target) return await preview(request, env, target);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unauthorized";
      return json({ code: "EAUTH", message }, 401);
    }
  },
} satisfies ExportedHandler<Env>;
