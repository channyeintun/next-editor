import { proxySlideImage } from "../src/googleSlides/imageProxy";

// Vercel Edge Function: GET /api/slide-image?url=<encoded https URL>.
// Proxy used to render Google Slides images at view time, working around
// Google's Cross-Origin-Resource-Policy header blocking direct cross-origin
// image loads (docs.google.com/slides-images-rt/…, *.googleusercontent.com).
// Imported slides' SVGs have their image hrefs rewritten to point here (see
// src/googleSlides/proxyImageHrefs.ts) rather than inlining the bytes, so
// persisted slide content stays small. Shares validation/fetch logic with the
// Vite dev-server middleware (tube/vite/slideImageProxyPlugin.ts) via
// imageProxy.ts.
export const config = { runtime: "edge" };

export default async function handler(request: Request): Promise<Response> {
  const target = new URL(request.url).searchParams.get("url");
  const result = await proxySlideImage(target);

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
}
