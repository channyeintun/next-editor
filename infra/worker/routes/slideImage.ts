import { Hono } from "hono";
import type { Env } from "../env";
import { proxySlideImage } from "../../../src/googleSlides/imageProxy";

// Mounted at /api/slide-image in worker/index.ts — the same canonical route
// name the Vercel Edge Function (api/slide-image.ts) and the Vite dev plugin
// (tube/vite/slideImageProxyPlugin.ts) already use, reusing the identical
// shared proxy core (src/googleSlides/imageProxy.ts). Also serves Google
// avatar images: they're hosted on *.googleusercontent.com (already covered
// by the same host allowlist) and send a Cross-Origin-Resource-Policy header
// that the app's COEP:require-corp blocks from a direct <img src> — the
// exact same problem Slides images have.
//
// Deliberately NOT added to the vite dev proxy: the existing
// slideImageProxyPlugin already intercepts this path directly in the vite
// dev server, independent of whether the Worker is running, so plain
// `bun run dev` (no `dev:worker`) keeps working unchanged. This
// implementation only actually gets exercised once deployed to Cloudflare
// for real (completing part of Phase 4's "move /api/slide-image into the
// Worker" ahead of schedule) — the Vercel Edge Function and Vite plugin stay
// in place untouched until that cutover.
export const slideImageRoute = new Hono<{ Bindings: Env }>();

slideImageRoute.get("/", async (c) => {
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
