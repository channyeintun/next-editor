import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { proxyOpenRouterResponses } from "../../src/shared/openrouterProxy";

/**
 * Dev-server equivalent of infra/worker/routes/openrouter.ts: serves the same
 * /api/openrouter/responses route so `bun run dev` matches the Worker route
 * used in production. Shares the forwarding logic with the Worker route via
 * src/shared/openrouterProxy.ts — this file only adapts Node's (req, res)
 * middleware signature to/from the Fetch Request/Response the shared core
 * expects, including streaming both the request and response bodies.
 */
export function openrouterProxyPlugin(): Plugin {
  return {
    name: "shared:openrouter-proxy",
    configureServer(server) {
      const handler = (req: Connect.IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }

        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === "string") {
            headers.set(key, value);
          } else if (Array.isArray(value)) {
            headers.set(key, value.join(", "));
          }
        }

        const request = new Request("http://internal/responses", {
          method: "POST",
          headers,
          body: Readable.toWeb(req) as unknown as ReadableStream,
          duplex: "half",
        } as RequestInit);

        proxyOpenRouterResponses(request)
          .then((response) => {
            res.statusCode = response.status;
            response.headers.forEach((value, key) => res.setHeader(key, value));
            if (!response.body) {
              res.end();
              return;
            }
            Readable.fromWeb(response.body as never).pipe(res);
          })
          .catch((error: unknown) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `Unexpected error: ${String(error)}` }));
          });
      };
      server.middlewares.use("/api/openrouter/responses", handler);
    },
  };
}
