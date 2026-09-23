import { createMiddleware } from "hono/factory";
import type { UserRow } from "../../db/types";
import type { Env } from "../env";
import { getCurrentUser } from "./session";

/** The context a handler behind requireUser sees: `c.get("user")` is the caller. */
export type SignedInEnv = { Bindings: Env; Variables: { user: UserRow } };

/**
 * Route middleware for endpoints that need a signed-in user. It answers 401
 * when there is none, and otherwise hands the handler the user as
 * `c.get("user")`. Mounted per route, since public GETs share these routers.
 *
 * The playground routes resolve the user inline instead: their kill switch
 * comes first, so a disabled playground answers 503 before it asks who is
 * calling. GET /api/auth/me and PATCH /api/auth/username in session.ts do too,
 * since this module imports session.ts.
 */
export const requireUser = createMiddleware<SignedInEnv>(async (c, next) => {
  const user = await getCurrentUser(c);
  if (!user) {
    return c.json({ error: "not signed in" }, 401);
  }
  c.set("user", user);
  await next();
});
