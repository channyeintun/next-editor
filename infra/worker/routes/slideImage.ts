import { Hono } from "hono";
import type { Env } from "../env";
import { proxySlideImage } from "../../../src/googleSlides/imageProxy";

// Mounted at /api/image-proxy in worker/index.ts. Reuses the same
// host-allowlisted (docs.google.com, *.googleusercontent.com) proxy core the
// Google Slides import feature already uses (src/googleSlides/imageProxy.ts)
// — Google's avatar images are also served from *.googleusercontent.com and
// send a Cross-Origin-Resource-Policy header that COEP:require-corp blocks
// from a direct <img src>. Deliberately a separate route from
// /api/slide-image (which stays on its current Vercel Edge Function + Vite
// dev-plugin path until Phase 4 moves it here) so plain `bun run dev` without
// `dev:worker` running keeps working for Slides unaffected.
export const imageProxyRoute = new Hono<{ Bindings: Env }>();

imageProxyRoute.get("/", async (c) => {
  const result = await proxySlideImage(c.req.query("url") ?? null);

  if (result.status !== 200 || !result.body) {
    return new Response(JSON.stringify({ error: result.error ?? "Failed to proxy image." }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      "Content-Type": result.contentType ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
    },
  });
});
