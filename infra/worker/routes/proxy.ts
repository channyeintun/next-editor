import { Hono } from "hono";
import type { Env } from "../env";
import { proxyUrl } from "../../../src/shared/proxy";

// Mounted at /api/proxy in worker/index.ts — the same canonical route name
// the Vite dev plugin (tube/vite/proxyPlugin.ts) uses, reusing the identical
// shared proxy core (src/shared/proxy.ts). A generic same-origin fetch
// proxy: originally built for Google Slides images and avatars (both hosted
// on domains that send a Cross-Origin-Resource-Policy header the app's
// COEP:require-corp blocks from a direct <img src>/fetch()), it now forwards
// any public https URL for whatever needs that same treatment.
//
// Deliberately NOT added to the vite dev proxy: the existing proxyPlugin
// already intercepts this path directly in the vite dev server, independent
// of whether the Worker is running, so plain `bun run dev` (no
// `dev:worker`) keeps working unchanged.
export const proxyRoute = new Hono<{ Bindings: Env }>();

proxyRoute.get("/", async (c) => {
  const result = await proxyUrl(c.req.query("url") ?? null);

  if (result.status !== 200 || !result.body) {
    return new Response(JSON.stringify({ error: result.error ?? "Failed to proxy request." }), {
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
