import { bearer, signToken, verifyToken } from "./auth";
import { RuntimeGoSessionDO } from "./sessionDo";
import type { Env, SessionRecord } from "./types";
import { previewTarget, type PreviewTarget } from "./routing";
import { runtimeMetric } from "./telemetry";

export { RuntimeGoSessionDO };

const jsonHeaders = { "Content-Type": "application/json" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionSecret(env: Env): string {
  if (
    typeof env.RUNTIME_SESSION_SECRET !== "string" ||
    new TextEncoder().encode(env.RUNTIME_SESSION_SECRET).byteLength < 32
  ) {
    throw new ApiError(503, "ECONFIG", "RUNTIME_SESSION_SECRET must contain at least 32 bytes");
  }
  return env.RUNTIME_SESSION_SECRET;
}

async function authenticated(request: Request, env: Env) {
  const secret = sessionSecret(env);
  try {
    return await verifyToken(secret, bearer(request));
  } catch (error) {
    throw new ApiError(401, "EAUTH", error instanceof Error ? error.message : "Unauthorized");
  }
}

function sessionStub(env: Env, sessionId: string): DurableObjectStub {
  return env.RUNTIME_GO_SESSIONS.get(env.RUNTIME_GO_SESSIONS.idFromName(sessionId));
}

async function sessionRecord(env: Env, sessionId: string): Promise<SessionRecord | null> {
  const row = await env.RUNTIME_QUOTAS.prepare(
    "SELECT session_id, user_id, runtime, created_at FROM runtime_sessions WHERE session_id = ? AND ended_at IS NULL",
  )
    .bind(sessionId)
    .first<{ session_id: string; user_id: string; runtime: "go1.26.5"; created_at: number }>();
  return (
    row && {
      sessionId: row.session_id,
      userId: row.user_id,
      runtime: row.runtime,
      createdAt: row.created_at,
    }
  );
}

async function authorizeSession(
  request: Request,
  env: Env,
  sessionId: string,
): Promise<SessionRecord> {
  let claims: Awaited<ReturnType<typeof verifyToken>>;
  const secret = sessionSecret(env);
  try {
    const queryToken = new URL(request.url).searchParams.get("token");
    claims = await verifyToken(secret, queryToken ?? bearer(request));
  } catch (error) {
    throw new ApiError(401, "EAUTH", error instanceof Error ? error.message : "Unauthorized");
  }
  if (claims.sessionId !== sessionId)
    throw new ApiError(401, "EAUTH", "token does not match session");
  const record = await sessionRecord(env, sessionId);
  if (!record || record.userId !== claims.userId)
    throw new ApiError(401, "EAUTH", "session not found");
  return record;
}

async function createSession(request: Request, env: Env): Promise<Response> {
  const claims = await authenticated(request, env);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "EBADREQUEST", "Request body must be valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "EBADREQUEST", "Request body must be a JSON object");
  }
  const options = body as {
    runtime?: unknown;
    workdirName?: unknown;
    idleTimeoutSeconds?: unknown;
  };
  if (
    options.idleTimeoutSeconds !== undefined &&
    (typeof options.idleTimeoutSeconds !== "number" || !Number.isFinite(options.idleTimeoutSeconds))
  ) {
    throw new ApiError(400, "EBADREQUEST", "idleTimeoutSeconds must be a finite number");
  }
  if ((options.runtime ?? "go1.26.5") !== "go1.26.5")
    return json({ code: "ERUNTIME", message: "Only go1.26.5 is enabled" }, 400);
  const workdirName = options.workdirName ?? "project";
  if (typeof workdirName !== "string") {
    return json({ code: "EWORKDIR", message: "Invalid workdirName" }, 400);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(workdirName) || workdirName === "." || workdirName === "..") {
    return json({ code: "EWORKDIR", message: "Invalid workdirName" }, 400);
  }
  const maxConcurrent = positiveInteger(env.MAX_CONCURRENT_SESSIONS, 2);
  const maxDailyMinutes = positiveInteger(env.MAX_DAILY_MINUTES, 120);
  const day = new Date().toISOString().slice(0, 10);
  const sessionId = crypto.randomUUID();
  const createdAt = Date.now();
  const reservation = await env.RUNTIME_QUOTAS.prepare(`INSERT INTO runtime_sessions
      (session_id, user_id, runtime, created_at)
    SELECT ?, ?, 'go1.26.5', ?
    WHERE (SELECT COUNT(*) FROM runtime_sessions WHERE user_id = ? AND ended_at IS NULL) < ?
      AND COALESCE((SELECT minutes FROM runtime_daily_usage WHERE user_id = ? AND day = ?), 0) < ?`)
    .bind(
      sessionId,
      claims.userId,
      createdAt,
      claims.userId,
      maxConcurrent,
      claims.userId,
      day,
      maxDailyMinutes,
    )
    .run();
  if (reservation.meta.changes !== 1) {
    const [active, _usage] = await Promise.all([
      env.RUNTIME_QUOTAS.prepare(
        "SELECT COUNT(*) AS count FROM runtime_sessions WHERE user_id = ? AND ended_at IS NULL",
      )
        .bind(claims.userId)
        .first<{ count: number }>(),
      env.RUNTIME_QUOTAS.prepare(
        "SELECT minutes FROM runtime_daily_usage WHERE user_id = ? AND day = ?",
      )
        .bind(claims.userId, day)
        .first<{ minutes: number }>(),
    ]);
    const concurrent = (active?.count ?? 0) >= maxConcurrent;
    runtimeMetric("quota_hit", {
      kind: concurrent ? "concurrent" : "daily_minutes",
      userId: claims.userId,
    });
    return json(
      {
        code: "EQUOTA",
        message: concurrent
          ? "Concurrent runtime limit reached"
          : "Daily runtime minutes exhausted",
      },
      429,
    );
  }
  let configured: Response;
  try {
    configured = await sessionStub(env, sessionId).fetch(
      new Request("http://do/__runtime/configure", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          userId: claims.userId,
          createdAt,
          idleTimeoutSeconds: options.idleTimeoutSeconds ?? 300,
          workdirName,
        }),
      }),
    );
  } catch (error) {
    await env.RUNTIME_QUOTAS.prepare(
      "UPDATE runtime_sessions SET ended_at = ? WHERE session_id = ?",
    )
      .bind(Date.now(), sessionId)
      .run();
    throw error;
  }
  if (!configured.ok) {
    await env.RUNTIME_QUOTAS.prepare(
      "UPDATE runtime_sessions SET ended_at = ? WHERE session_id = ?",
    )
      .bind(Date.now(), sessionId)
      .run();
    return json({ code: "EPROVISION", message: "Failed to configure runtime session" }, 503);
  }
  const token = await signToken(sessionSecret(env), {
    userId: claims.userId,
    sessionId,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const origin = new URL(request.url);
  const wsProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProtocol}//${origin.host}/api/runtime/sessions/${sessionId}/ws`;
  runtimeMetric("session_created", { sessionId, userId: claims.userId, runtime: "go1.26.5" });
  return json(
    {
      sessionId,
      token,
      wsUrl,
      previewUrlTemplate: env.PREVIEW_URL_TEMPLATE.replaceAll("{{sessionId}}", sessionId),
    },
    201,
  );
}

async function closeSession(request: Request, env: Env, sessionId: string): Promise<Response> {
  await authorizeSession(request, env, sessionId);
  return sessionStub(env, sessionId).fetch(
    new Request("http://do/__runtime/destroy", { method: "DELETE" }),
  );
}

async function apiRoute(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/sessions" && request.method === "POST") return createSession(request, env);
  const match = path.match(/^\/sessions\/([0-9a-f-]+)\/(ws|preview-script)$/);
  if (match) {
    const [, sessionId, action] = match;
    await authorizeSession(request, env, sessionId!);
    if (action === "ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket required", { status: 426 });
      return sessionStub(env, sessionId!).fetch(new Request("http://do/ws", request));
    }
    if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
    return sessionStub(env, sessionId!).fetch(
      new Request("http://do/__runtime/preview-script", request),
    );
  }
  const deletion = path.match(/^\/sessions\/([0-9a-f-]+)$/);
  if (deletion && request.method === "DELETE") return closeSession(request, env, deletion[1]!);
  return new Response("Not found", { status: 404 });
}

async function preview(request: Request, env: Env, target: PreviewTarget): Promise<Response> {
  if (target.port < 1 || target.port > 65535 || !(await sessionRecord(env, target.sessionId)))
    return new Response("Not found", { status: 404 });
  const headers = new Headers(request.headers);
  headers.delete("Cookie");
  headers.delete("Authorization");
  const url = new URL(request.url);
  const internal = new URL(
    `/__runtime/preview/${target.port}${target.path}${url.search}`,
    "http://do",
  );
  return sessionStub(env, target.sessionId).fetch(
    new Request(internal, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/runtime"))
        return await apiRoute(request, env, url.pathname.slice("/api/runtime".length));
      const target = previewTarget(request);
      if (target) return await preview(request, env, target);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof ApiError)
        return json({ code: error.code, message: error.message }, error.status);
      console.error("Remote runtime worker error", error);
      const message = error instanceof Error ? error.message : "Internal error";
      return json({ code: "EINTERNAL", message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
