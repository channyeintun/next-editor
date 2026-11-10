import type { Context } from "hono";
import type { Env } from "../env";

// What a collaboration transport (the room socket, the voice socket and the
// voice SFU proxy) checks about its caller beyond the session cookie. Shared by
// routes/collaboration.ts and routes/collaborationVoice.ts.

/**
 * Whether the request's Origin may open a collaboration transport. Browsers
 * apply no CORS to WebSockets and the session cookie is ambient, so without
 * this a page from another origin, or a sandboxed frame (Origin "null", such
 * as replayed lesson preview HTML), could open a socket that reads and writes
 * the room as whoever is signed in. Browsers always send Origin on WebSocket
 * upgrades and on non-GET fetches; a mismatch is rejected. Local development
 * uses the Vite proxy, so loopback origins are also accepted.
 */
export function isAllowedCollaborationOrigin<E extends { Bindings: Env }>(c: Context<E>): boolean {
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
