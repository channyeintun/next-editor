import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env } from "../env";
import { isJsonObject, readJsonWithLimit } from "../httpBody";
import {
  createSession,
  deleteSession,
  deleteUserSessions,
  getLiveSession,
  type LiveSession,
  updateUsername,
  USERNAME_PATTERN,
} from "../../db/queries";
import { type SessionRow, userRowToAuthUser } from "../../db/types";

/** The session cookie's name, before the prefix it carries over https (signInCookiePrefix). */
const SESSION_COOKIE = "ne_session";
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

/**
 * The prefix every sign-in cookie carries over https: `__Host-`. A browser
 * takes a `__Host-` cookie only from this host itself, with no Domain, so a
 * page on a subdomain cannot set one that reaches this host. Subdomains run
 * lesson code (the webnode hosts, webnodePreviewHost.ts); without the prefix
 * that code could set a `Domain=` cookie of the same name and have the
 * visitor's requests carry the attacker's session, or plant a sign-in
 * handshake. The prefix needs Secure, so plain http (local development) goes
 * without it.
 *
 * Only the prefixed name is read over https: falling back to the bare name
 * would let a subdomain's cookie through again.
 */
export function signInCookiePrefix(c: Context): "host" | undefined {
  return isHttps(c) ? "host" : undefined;
}

/** The id in this request's session cookie, if it has one. */
export function sessionCookieValue(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE, signInCookiePrefix(c));
}

// Plain (unsigned) opaque token — it's validated against the sessions table on
// every request, so a tampered value just fails the DB lookup; signing would
// add no security here (unlike the transient OAuth handshake cookie in
// google.ts, which has no DB backing and so needs tamper protection itself).
// The cookie lives exactly as long as the row createSession wrote.
function setSessionCookie(c: Context, session: SessionRow): void {
  setCookie(c, SESSION_COOKIE, session.id, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor((session.expires_at - session.created_at) / 1000),
    prefix: signInCookiePrefix(c),
  });
}

/**
 * Signs the user in on this response: writes a session row and sets its
 * cookie. Every sign-in path (Google One Tap, the Google redirect, passkeys)
 * ends here. The session this browser held before, if any, ends here too,
 * since its cookie is being replaced.
 */
export async function startSession<E extends { Bindings: Env }>(
  c: Context<E>,
  userId: string,
): Promise<SessionRow> {
  const session = await createSession(c.env.DB, userId, {
    replaces: sessionCookieValue(c),
  });
  setSessionCookie(c, session);
  return session;
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", prefix: signInCookiePrefix(c) });
}

/**
 * The current request's live session, with when it signed in, or null. Only
 * the routes that care how recently the user proved who they are need this
 * (requireRecentSignIn); the rest ask getCurrentUser.
 */
export async function getCurrentSession<E extends { Bindings: Env }>(
  c: Context<E>,
): Promise<LiveSession | null> {
  const sessionId = sessionCookieValue(c);
  if (!sessionId) return null;
  return getLiveSession(c.env.DB, sessionId);
}

// Resolves the signed-in user for the current request, or null. Every
// authenticated route in the Worker calls this.
export async function getCurrentUser<E extends { Bindings: Env }>(c: Context<E>) {
  return (await getCurrentSession(c))?.user ?? null;
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
  const sessionId = sessionCookieValue(c);
  if (sessionId) {
    await deleteSession(c.env.DB, sessionId);
  }
  clearSessionCookie(c);
  return c.json({ success: true });
});

// Ends every session the account has, this browser's included: the way out
// when a device was lost or a session may have been copied. A passkey added
// from such a session is removed separately (DELETE
// /api/auth/passkey/credentials/:id), since a passkey is not a session.
authRoute.post("/logout-everywhere", async (c) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }
  await deleteUserSessions(c.env.DB, user.id);
  clearSessionCookie(c);
  return c.json({ success: true });
});
