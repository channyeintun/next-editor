import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { lessonsRoute } from "./routes/lessons";
import { playlistsRoute } from "./routes/playlists";
import { authorsRoute } from "./routes/authors";
import { searchRoute } from "./routes/search";
import { mediaRoute } from "./routes/media";
import { authRoute } from "./auth/session";
import { googleAuthRoute } from "./auth/google";
import { passkeyRoute } from "./auth/passkey";
import { uploadsRoute } from "./routes/uploads";
import { proxyRoute } from "./routes/proxy";
import { slideImagesRoute } from "./routes/slideImages";
import { openrouterRoute } from "./routes/openrouter";
import { goPlaygroundRoute } from "./routes/goPlayground";
import { kotlinPlaygroundRoute } from "./routes/kotlinPlayground";
import { rustPlaygroundRoute } from "./routes/rustPlayground";
import { collaborationRoute } from "./routes/collaboration";
import { renderLandingResponse } from "./ssr/landing";

const app = new Hono<{ Bindings: Env }>();

// The app requires cross-origin isolation on every response (WebContainers
// need SharedArrayBuffer). Static Assets/ASSETS.fetch don't add it, so it
// has to happen here. Rebuilds
// the Response rather than mutating c.res.headers in place, since responses
// coming back from a Fetcher binding (ASSETS.fetch) may have immutable headers.
app.use("*", async (c, next) => {
  await next();
  // Reconstructing a 101 response drops its WebSocket handle. Cross-origin
  // isolation applies to documents and subresources, not the upgraded stream.
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") return;
  const headers = new Headers(c.res.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

// One structured, queryable log line per API/media request (Workers Logs
// indexes the object's fields). The X-POSTHOG-* headers are stamped on
// same-host fetches by the SPA (__add_tracing_headers in src/main.tsx), so a
// PostHog session/replay can be cross-referenced with its backend requests
// and vice versa. Deliberately not registered on "*": static-asset traffic
// would drown the 200k events/day free-plan quota.
const requestLog: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const startedAt = Date.now();
  await next();
  console.log("request", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
    phSessionId: c.req.header("X-POSTHOG-SESSION-ID") ?? null,
    phDistinctId: c.req.header("X-POSTHOG-DISTINCT-ID") ?? null,
  });
};
app.use("/api/*", requestLog);
app.use("/media/*", requestLog);

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.route("/api/lessons", lessonsRoute);
app.route("/api/playlists", playlistsRoute);
app.route("/api/authors", authorsRoute);
app.route("/api/search", searchRoute);
app.route("/media", mediaRoute);
app.route("/api/auth", authRoute);
app.route("/api/auth/google", googleAuthRoute);
app.route("/api/auth/passkey", passkeyRoute);
app.route("/api/uploads", uploadsRoute);
app.route("/api/proxy", proxyRoute);
app.route("/api/openrouter", openrouterRoute);
app.route("/api/go-playground", goPlaygroundRoute);
app.route("/api/kotlin-playground", kotlinPlaygroundRoute);
app.route("/api/rust-playground", rustPlaygroundRoute);
app.route("/api/collaboration", collaborationRoute);
// Slide-image R2 ingestion. The pre-/api/proxy-rename alias /api/slide-image
// (singular) is gone: every persisted document that referenced it was
// migrated to /media/slide-images/<hash> hrefs on 2026-07-11.
app.route("/api/slide-images", slideImagesRoute);

// Render the public landing page at the edge so crawlers and answer engines
// receive its semantic content in the initial HTML. The hydrated browser app
// takes over after load; editor and lesson routes keep their existing CSR path.
app.get("/", async (c) => renderLandingResponse(await c.env.ASSETS.fetch(c.req.raw)));

// Workers Static Assets already tried to match the request against dist/ and
// missed before this Worker ran (exact-match static files — JS chunks, the
// seed /lessons/*.json shards, images — are served without ever reaching
// here). Anything left is an SPA route (/code, /learn, /learn/:slug) or an
// unimplemented API path. `not_found_handling = "single-page-application"`
// in wrangler.toml makes this ASSETS.fetch return index.html (200) for the
// requested path directly — no redirect.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
export { CollaborationRoomDurableObject } from "./collaboration/roomDurableObject";
export { CollaborationVoiceRoomDurableObject } from "./collaboration/voiceDurableObject";
