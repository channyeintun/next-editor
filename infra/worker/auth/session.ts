import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "../env";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import { deleteSession, getSessionUser, updateUsername, USERNAME_PATTERN } from "../../db/queries";
import { type SessionRow, userRowToAuthUser } from "../../db/types";

export const SESSION_COOKIE = "ne_session";
// A username change carries one short username.
const MAX_USERNAME_REQUEST_BYTES = 1024;

/**
 * Whether this request arrived over https, for a cookie's `secure` flag: derived
 * from the request's own scheme rather than hardcoded, so local http dev and
 * https production both work without extra config.
 */
export function isHttps(c: Context): boolean {
  return new URL(c.req.url).protocol === "https:";
}

// Plain (unsigned) opaque token — it's validated against the sessions table on
// every request, so a tampered value just fails the DB lookup; signing would
// add no security here (unlike the transient OAuth handshake cookie in
// google.ts, which has no DB backing and so needs tamper protection itself).
// The cookie lives exactly as long as the row createSession wrote.
export function setSessionCookie(c: Context, session: SessionRow): void {
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor((session.expires_at - session.created_at) / 1000),
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

// Resolves the signed-in user for the current request, or null. Every
// authenticated route in the Worker calls this.
export async function getCurrentUser<E extends { Bindings: Env }>(c: Context<E>) {
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

  const read = await readJsonWithLimit(c.req.raw, MAX_USERNAME_REQUEST_BYTES);
  if (read.status === "too-large") {
    return c.json({ error: "request body is too large" }, 413);
  }
  const body = read.status === "ok" && isJsonObject(read.value) ? read.value : null;
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
