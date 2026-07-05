import { Hono } from "hono";
import type { Env } from "./env";
import { lessonsRoute } from "./routes/lessons";
import { mediaRoute } from "./routes/media";

const app = new Hono<{ Bindings: Env }>();

// The app requires cross-origin isolation on every response (WebContainers
// need SharedArrayBuffer) — vercel.json sets this today via a header rule;
// Static Assets/ASSETS.fetch don't add it, so it has to happen here. Rebuilds
// the Response rather than mutating c.res.headers in place, since responses
// coming back from a Fetcher binding (ASSETS.fetch) may have immutable headers.
app.use("*", async (c, next) => {
  await next();
  const headers = new Headers(c.res.headers);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  c.res = new Response(c.res.body, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers,
  });
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.route("/api/lessons", lessonsRoute);
app.route("/media", mediaRoute);

// Workers Static Assets already tried to match the request against dist/ and
// missed before this Worker ran (exact-match static files — JS chunks, the
// seed /lessons/*.json shards, images — are served without ever reaching
// here). Anything left is an SPA route (/code, /learn, /learn/:slug) or an
// unimplemented API path. `not_found_handling = "single-page-application"`
// in wrangler.toml makes this ASSETS.fetch return index.html (200) for the
// requested path directly — no redirect — the same effect as vercel.json's
// catch-all rewrite today.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
