import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "../env";
import { deleteSession, getSessionUser, updateUsername } from "../../db/queries";
import { userRowToAuthUser } from "../../db/types";

export const SESSION_COOKIE = "ne_session";
// Matches createSession's TTL in db/queries.ts.
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Same shape the auto-generated usernames already satisfy (see
// slugifyUsername in db/queries.ts): 3-32 chars, lowercase alphanumeric and
// hyphens, no leading/trailing hyphen.
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

// Plain (unsigned) opaque token — it's validated against the sessions table on
// every request, so a tampered value just fails the DB lookup; signing would
// add no security here (unlike the transient OAuth handshake cookie in
// google.ts, which has no DB backing and so needs tamper protection itself).
// `secure` is derived from the request's own scheme rather than hardcoded, so
// local http dev and https production both work without extra config.
export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// Resolves the signed-in user for the current request, or null. Shared by
// GET /api/auth/me here and (Phase 3) ownership checks on lesson mutations.
export async function getCurrentUser(c: Context<{ Bindings: Env }>) {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (!sessionId) return null;
  return getSessionUser(c.env.DB, sessionId);
}

// Mounted at /api/auth in worker/index.ts.
export const authRoute = new Hono<{ Bindings: Env }>();

authRoute.get("/me", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }
  return c.json({ user: userRowToAuthUser(user) });
});

authRoute.patch("/username", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }

  const body = await c.req.json<{ username?: unknown }>().catch(() => null);
  const requested = typeof body?.username === "string" ? body.username.trim().toLowerCase() : "";
  if (!USERNAME_PATTERN.test(requested)) {
    return c.json(
      { error: "Use 3-32 lowercase letters, numbers, and hyphens (no leading/trailing hyphen)" },
      400,
    );
  }

  const result = await updateUsername(c.env.DB, user.id, requested);
  if (result.status === "taken") {
    return c.json({ error: "That username is already taken" }, 409);
  }
  return c.json({ user: userRowToAuthUser(result.user) });
});

authRoute.post("/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) {
    await deleteSession(c.env.DB, sessionId);
  }
  clearSessionCookie(c);
  return c.json({ success: true });
});
