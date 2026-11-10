import { createMiddleware } from "hono/factory";
import type { UserRow } from "../../db/types";
import type { Env } from "../env";
import { getCurrentSession, getCurrentUser } from "./session";

/** The context a handler behind requireUser sees: `c.get("user")` is the caller. */
export type SignedInEnv = { Bindings: Env; Variables: { user: UserRow } };

/**
 * Route middleware for endpoints that need a signed-in user. It answers 401
 * when there is none, and otherwise hands the handler the user as
 * `c.get("user")`. Mounted per route, since public GETs share these routers.
 *
 * The playground routes resolve the user inline instead: their kill switch
 * comes first, so a disabled playground answers 503 before it asks who is
 * calling. GET /api/auth/me, PATCH /api/auth/username and POST
 * /api/auth/logout-everywhere in session.ts do too, since this module imports
 * session.ts. So do the collaboration WebSocket
 * upgrade, which answers 426 to a non-upgrade request first, and the voice
 * transports' resolveVoiceAccess, whose voice flag and Origin checks come first.
 */
export const requireUser = createMiddleware<SignedInEnv>(async (c, next) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }
  c.set("user", user);
  await next();
});

/**
 * requireUser for the actions that hand out a lasting way back into the
 * account, such as adding a passkey. A session lives 30 days, so "has a live
 * session" only proves someone held this browser (or a copy of its cookie)
 * at some point in that span. These actions also need the session itself to
 * be a recent sign-in: one made within `withinMs` of now. An older session
 * answers 403 with `reauthenticate: true`, which the client turns into
 * "sign in again"; a fresh Google or passkey sign-in starts a new session
 * and so passes.
 */
export function requireRecentSignIn(withinMs: number) {
  return createMiddleware<SignedInEnv>(async (c, next) => {
    const session = await getCurrentSession(c);
    if (!session) {
      return c.json({ error: "not signed in" }, 401);
    }
    if (Date.now() - session.signedInAt > withinMs) {
      return c.json(
        { error: "For your security, sign in again to continue.", reauthenticate: true },
        403,
      );
    }
    c.set("user", session.user);
    await next();
  });
}
