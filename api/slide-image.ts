import { proxySlideImage } from "../src/googleSlides/imageProxy";

// Vercel Edge Function: GET /api/slide-image?url=<encoded https URL>.
// Transient proxy used only at Google Slides import time to work around
// Google's Cross-Origin-Resource-Policy header blocking direct cross-origin
// image loads (docs.google.com/slides-images-rt/…, *.googleusercontent.com).
// Not a persistence layer: the client inlines the response as a data: URL
// (see src/googleSlides/inlineImages.ts) so imported slides never depend on
// this endpoint again. Shares validation/fetch logic with the Vite dev-server
// middleware (tube/vite/slideImageProxyPlugin.ts) via imageProxy.ts.
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
