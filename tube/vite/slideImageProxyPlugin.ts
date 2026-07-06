import type { Plugin } from "vite";
import { proxySlideImage } from "../../src/googleSlides/imageProxy";

/**
 * Dev-server equivalent of infra/worker/routes/slideImage.ts: serves the same
 * transient Google Slides image proxy at /api/slide-image?url=<encoded https
 * URL> so `bun run dev` matches the Worker route used in production. Shares
 * all validation/fetch logic with the Worker route via imageProxy.ts — this
 * file only adapts the result to Node's (req, res) middleware signature.
 */
export function slideImageProxyPlugin(): Plugin {
  return {
    name: "google-slides:slide-image-proxy",
    configureServer(server) {
      server.middlewares.use("/api/slide-image", (req, res) => {
        const fullUrl = new URL(req.url ?? "", "http://internal");
        const target = fullUrl.searchParams.get("url");
        proxySlideImage(target)
          .then((result) => {
            if (result.status !== 200 || !result.body) {
              res.statusCode = result.status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: result.error ?? "Failed to proxy image." }));
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", result.contentType ?? "application/octet-stream");
            res.setHeader("Cache-Control", "public, max-age=86400");
            res.end(Buffer.from(result.body));
          })
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `Unexpected error: ${String(error)}` }));
          });
      });
    },
  };
}
