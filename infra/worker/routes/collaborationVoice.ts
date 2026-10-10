import { Hono } from "hono";
import type { Context } from "hono";
import { collaborationIdSchema } from "../../../src/collaboration/protocol";
import {
  MAX_VOICE_SFU_REQUEST_BYTES,
  VOICE_CAPABILITY_HEADER,
  voiceCapabilitySchema,
} from "../../../src/voice/protocol";
import { getCollaborationRoomAccess } from "../../db/collaborationQueries";
import { requireUser } from "../auth/requireUser";
import { getCurrentUser } from "../auth/session";
import {
  forwardCollaborationVoiceSfuRequest,
  forwardCollaborationVoiceWebSocket,
  isVoiceChatEnabled,
  type CanonicalVoiceSession,
} from "../collaboration/voiceDurableObject";
import type { Env } from "../env";

// The room-scoped voice gateway: availability, the voice WebSocket and the SFU
// proxy. Voice fails closed on its own flag, Origin policy and D1 membership
// while the document endpoints carry on. Mounted on collaborationRoute.
export const collaborationVoiceRoute = new Hono<{ Bindings: Env }>();

// Origins allowed to open voice transports. Browsers always send Origin on
// WebSocket upgrades and on non-GET fetches; a mismatch is rejected. Local
// development uses the Vite proxy, so loopback origins are also accepted.
function isAllowedVoiceOrigin<E extends { Bindings: Env }>(c: Context<E>): boolean {
  const origin = c.req.header("Origin");
  if (!origin) return c.req.method === "GET";
  try {
    const parsed = new URL(origin);
    const requestUrl = new URL(c.req.url);
    const requestIsLoopback =
      requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1";
    if (requestIsLoopback && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
      return true;
    }
    if (origin === new URL(c.env.PUBLIC_URL).origin) return true;
    return origin === requestUrl.origin;
  } catch {
    return false;
  }
}

// Loads the caller's canonical voice identity for an active room, or maps the
// failure to a sanitized response. Voice must fail closed while the document
// collaboration endpoints continue normally.
async function resolveVoiceAccess<E extends { Bindings: Env }>(
  c: Context<E>,
  collaborationSessionId: string,
): Promise<{ ok: true; session: CanonicalVoiceSession } | { ok: false; response: Response }> {
  if (!isVoiceChatEnabled(c.env)) {
    return { ok: false, response: c.json({ error: "voice chat unavailable" }, 503) };
  }
  if (!isAllowedVoiceOrigin(c)) {
    return { ok: false, response: c.json({ error: "unauthorized" }, 403) };
  }
  const user = await getCurrentUser(c);
  if (!user) return { ok: false, response: c.json({ error: "not signed in" }, 401) };
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  const sessionId = collaborationIdSchema.safeParse(collaborationSessionId);
  if (!roomId.success || !sessionId.success) {
    return { ok: false, response: c.json({ error: "invalid voice session" }, 400) };
  }
  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access) return { ok: false, response: c.json({ error: "not found" }, 404) };
  if (access.status !== "active") {
    return { ok: false, response: c.json({ error: "room is not active" }, 409) };
  }
  return {
    ok: true,
    session: {
      roomId: access.id,
      userId: user.id,
      displayName: user.name?.trim() || user.username,
      role: access.member_role,
      roleVersion: access.role_version,
      collaborationSessionId: sessionId.data,
      maxMembers: access.max_members,
    },
  };
}

// Lets the client decide whether to render voice controls at all. Always a
// sanitized 200 for authenticated members; the real gates re-run on every
// voice transport request.
collaborationVoiceRoute.get("/rooms/:roomId/voice/availability", requireUser, async (c) => {
  const user = c.get("user");
  const roomId = collaborationIdSchema.safeParse(c.req.param("roomId"));
  if (!roomId.success) return c.json({ error: "invalid room id" }, 400);
  const access = await getCollaborationRoomAccess(c.env.DB, roomId.data, user.id);
  if (!access) return c.json({ error: "not found" }, 404);
  const enabled = isVoiceChatEnabled(c.env) && access.status === "active";
  return c.json({ enabled }, 200, { "Cache-Control": "private, no-store" });
});

collaborationVoiceRoute.get("/rooms/:roomId/voice/websocket", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "expected WebSocket upgrade" }, 426);
  }
  const resolved = await resolveVoiceAccess(c, c.req.query("collaborationSessionId") ?? "");
  if (!resolved.ok) return resolved.response;
  return forwardCollaborationVoiceWebSocket(c.env, c.req.raw, resolved.session);
});

// Secured SFU gateway used by the partytracks client. The Worker
// re-authenticates the application session and D1 membership; the voice
// Durable Object then verifies the connection capability and the full
// session/track/mid ownership matrix before proxying upstream.
collaborationVoiceRoute.all("/rooms/:roomId/voice/sfu/*", async (c) => {
  if (c.req.method !== "POST" && c.req.method !== "PUT") {
    return c.json({ error: "unsupported operation" }, 403, { "Cache-Control": "no-store" });
  }
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return c.json({ error: "unsupported content type" }, 415, {
      "Cache-Control": "no-store",
    });
  }
  // A declared Content-Length is REQUIRED, not defaulted to 0: a default let a
  // chunked request (no Content-Length) straight past this check. The header is
  // only the cheap first gate; the voice DO still bounds the body as it reads it
  // (readBodyWithLimit), so a lying header cannot exhaust its memory.
  const contentLengthHeader = c.req.header("content-length");
  const contentLength = Number(contentLengthHeader);
  if (
    contentLengthHeader === undefined ||
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > MAX_VOICE_SFU_REQUEST_BYTES
  ) {
    return c.json({ error: "payload too large" }, 413, { "Cache-Control": "no-store" });
  }
  const capability = voiceCapabilitySchema.safeParse(c.req.header(VOICE_CAPABILITY_HEADER));
  const voiceConnectionId = collaborationIdSchema.safeParse(c.req.query("voiceConnectionId"));
  const collaborationSessionId = c.req.query("collaborationSessionId") ?? "";
  if (!capability.success || !voiceConnectionId.success) {
    return c.json({ error: "unauthorized" }, 403, { "Cache-Control": "no-store" });
  }
  const resolved = await resolveVoiceAccess(c, collaborationSessionId);
  if (!resolved.ok) return resolved.response;
  const path = new URL(c.req.url).pathname;
  const marker = "/voice/sfu";
  const subpath = path.slice(path.indexOf(marker) + marker.length);
  return forwardCollaborationVoiceSfuRequest(c.env, c.req.raw, {
    session: resolved.session,
    subpath,
    capability: capability.data,
    voiceConnectionId: voiceConnectionId.data,
  });
});
