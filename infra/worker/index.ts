import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { mount } from "hono/mount";
import type { Env } from "./env";
import { lessonsRoute } from "./routes/lessons";
import { playlistsRoute } from "./routes/playlists";
import { authorsRoute } from "./routes/authors";
import { searchRoute } from "./routes/search";
import { mediaRoute } from "./routes/media";
import { authRoute } from "./auth/session";
import { googleAuthRoute } from "./auth/google";
import { uploadsRoute } from "./routes/uploads";
import { proxyRoute } from "./routes/proxy";
import { slideImagesRoute } from "./routes/slideImages";
import { openrouterRoute } from "./routes/openrouter";
import { goPlaygroundRoute } from "./routes/goPlayground";
import { haskellPlaygroundRoute } from "./routes/haskellPlayground";
import { kotlinPlaygroundRoute } from "./routes/kotlinPlayground";
import { rustPlaygroundRoute } from "./routes/rustPlayground";
import { zigPlaygroundRoute } from "./routes/zigPlayground";
import { collaborationRoute } from "./routes/collaboration";
import { studioRoute } from "./routes/studio";
import { athanlabRoute, athanlabTtsRoute } from "./routes/athanlab";
import { LANDING_DOCUMENT_URLS, serveAppShell, serveLandingDocument } from "./ssr/staticDocuments";
import { serveLessonDetailDocument } from "./ssr/lessonDetailRoute";
import { serveStaticFile } from "./staticAssets";

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

// SameSite=Lax keeps the session cookie off cross-site POSTs, but the response to
// a cross-site top-level form POST can still set one. So a state-changing request
// with a form-submittable body (urlencoded, multipart, text/plain or none) must
// come from this origin: otherwise another site could auto-submit a text/plain
// form whose body parses as JSON to /api/auth/google/onetap and sign the visitor
// into the attacker's account (login CSRF). For the cookie-authenticated routes
// the guard also backs up SameSite. The SPA's own requests are same-origin, and
// QStash's maintenance callback is JSON.
app.use("/api/*", csrf());

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.route("/api/lessons", lessonsRoute);
app.route("/api/playlists", playlistsRoute);
app.route("/api/authors", authorsRoute);
app.route("/api/search", searchRoute);
app.route("/media", mediaRoute);
app.route("/api/auth", authRoute);
app.route("/api/auth/google", googleAuthRoute);
// Loaded on first use rather than with the rest of the routes: passkey sign-in
// is rare, and @simplewebauthn/server drags in the @peculiar ASN.1 stack
// (tsyringe + reflect-metadata decorators), which would otherwise evaluate on
// every isolate start. The bundle stays a single file; esbuild only defers
// running the module until this import.
app.all(
  "/api/auth/passkey/*",
  mount(async (request, env, executionCtx) => {
    const { passkeyRoute } = await import("./auth/passkey");
    return passkeyRoute.fetch(request, env, executionCtx);
  }),
);
app.route("/api/uploads", uploadsRoute);
app.route("/api/proxy", proxyRoute);
app.route("/api/openrouter", openrouterRoute);
app.route("/api/go-playground", goPlaygroundRoute);
app.route("/api/haskell-playground", haskellPlaygroundRoute);
app.route("/api/kotlin-playground", kotlinPlaygroundRoute);
app.route("/api/rust-playground", rustPlaygroundRoute);
app.route("/api/zig-playground", zigPlaygroundRoute);
app.route("/api/collaboration", collaborationRoute);
app.route("/api/studio", studioRoute);
// Burmese Studio narration with each user's own AthanLab key: key custody,
// voices and usage, and the synthesis endpoint beside /api/studio/tts/voxcpm2.
app.route("/api/studio/athanlab", athanlabRoute);
app.route("/api/studio/tts/athanlab", athanlabTtsRoute);
// Slide-image R2 ingestion. The pre-/api/proxy-rename alias /api/slide-image
// (singular) is gone: every persisted document that referenced it was
// migrated to /media/slide-images/<hash> hrefs on 2026-07-11.
app.route("/api/slide-images", slideImagesRoute);

// The public landing page with its markup in the initial HTML, for crawlers
// and answer engines; the browser app hydrates it. Prerendered by the client
// build (ssr/landing.tsx), so it is served as a static asset, as is. Its file
// has URLs of its own, which keep answering like any path with no file.
app.get("/", (c) => serveLandingDocument(c.env.ASSETS, c.req.raw));
app.on(["GET", "HEAD"], LANDING_DOCUMENT_URLS, (c) => serveAppShell(c.env.ASSETS, c.req.raw));

// Data-only SSR for lesson detail (ssr/lessonDetailRoute.ts): per-lesson
// metadata for crawlers and the row dehydrated into React Query's cache, on
// top of the SPA shell. Author profiles (/learn/@username) share the segment.
app.get("/learn/:slug", (c) => serveLessonDetailDocument(c.env, c.req.raw, c.req.param("slug")));

// `run_worker_first = true` (wrangler.toml) sends every request through this
// Worker, so this catch-all serves all the static files too — JS chunks, the
// seed /lessons/*.json shards, images — and the "*" middleware above stamps
// COEP/COOP on them. For a path with no file (an SPA route such as /code or
// /learn/:slug, or an unimplemented API path), `not_found_handling =
// "single-page-application"` makes ASSETS.fetch return index.html (200)
// directly, with no redirect. Hashed /assets/* files are cached for a year,
// and a missing one is a 404 rather than that shell (staticAssets.ts).
app.all("*", (c) => serveStaticFile(c.env, c.req.raw));

export default app;
export { CollaborationRoomDurableObject } from "./collaboration/roomDurableObject";
export { CollaborationVoiceRoomDurableObject } from "./collaboration/voiceDurableObject";
