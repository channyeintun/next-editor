import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { proxyUrl } from "../../src/shared/proxy";

/**
 * Dev-server equivalent of infra/worker/routes/proxy.ts: serves the same
 * generic fetch proxy at /api/proxy?url=<encoded https URL> so `bun run dev`
 * matches the Worker route used in production. Shares all validation/fetch
 * logic with the Worker route via src/shared/proxy.ts — this file only
 * adapts the result to Node's (req, res) middleware signature.
 */
export function proxyPlugin(): Plugin {
  return {
    name: "shared:proxy",
    configureServer(server) {
      const handler = (req: Connect.IncomingMessage, res: ServerResponse) => {
        const fullUrl = new URL(req.url ?? "", "http://internal");
        const target = fullUrl.searchParams.get("url");
        proxyUrl(target)
          .then((result) => {
            if (result.status !== 200 || !result.body) {
              res.statusCode = result.status;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: result.error ?? "Failed to proxy request." }));
              return;
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", result.contentType ?? "application/octet-stream");
            res.setHeader("Cache-Control", "public, max-age=86400");
            // Same document-rendering guard as the Worker route (see
            // infra/worker/routes/proxy.ts): proxied bytes must never render
            // as an HTML document in this origin.
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Content-Disposition", "attachment");
            Readable.fromWeb(result.body as never)
              .on("error", () => res.destroy())
              .pipe(res);
          })
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `Unexpected error: ${String(error)}` }));
          });
      };
      server.middlewares.use("/api/proxy", handler);
    },
  };
}
