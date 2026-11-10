import type { Connect, Plugin } from "vite";
import type { ServerResponse } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { isPubliclyRoutableHost, proxyUrl } from "../../src/shared/proxy";

/** Every address a name resolves to, as the OS resolver (and so Node's fetch) sees it. */
export type LookupAllAddresses = (hostname: string) => Promise<readonly { address: string }[]>;

const lookupAllAddresses: LookupAllAddresses = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

/**
 * Refuses a name that resolves to a loopback, private, link-local, CGNAT or
 * otherwise non-public address. The shared rules only see the name, and on a
 * developer's machine names such as `127-0-0-1.nip.io`, split-horizon intranet
 * hosts or /etc/hosts entries reach the loopback and the LAN, which the
 * Worker's egress never does. Each address is classified by the same
 * isPubliclyRoutableHost rules the shared validator applies to literals.
 *
 * Node's fetch resolves the name again when it connects, so a resolver that
 * answers differently the second time is not covered; the dev server's own
 * host validation and CORS already keep other sites from reading this route.
 */
export async function checkResolvedHost(
  hostname: string,
  lookupAll: LookupAllAddresses = lookupAllAddresses,
): Promise<string | null> {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  // An address literal was already classified by the shared validator.
  if (isIP(bare) !== 0) return null;
  const addresses = await lookupAll(bare);
  if (addresses.length === 0) throw new Error(`No addresses found for ${hostname}`);
  return addresses.every(({ address }) => isPubliclyRoutableHost(address))
    ? null
    : `Host '${hostname}' resolves to a non-public address.`;
}

/**
 * Dev-server equivalent of infra/worker/routes/proxy.ts: serves the same
 * generic fetch proxy at /api/proxy?url=<encoded https URL> so `bun run dev`
 * matches the Worker route used in production. Shares all validation/fetch
 * logic with the Worker route via src/shared/proxy.ts — this file only
 * adapts the result to Node's (req, res) middleware signature and adds the
 * resolved-address check that only a Node runtime can make.
 */
export function proxyPlugin(options: { lookupAll?: LookupAllAddresses } = {}): Plugin {
  const lookupAll = options.lookupAll ?? lookupAllAddresses;
  return {
    name: "shared:proxy",
    configureServer(server) {
      const handler = (req: Connect.IncomingMessage, res: ServerResponse) => {
        const fullUrl = new URL(req.url ?? "", "http://internal");
        const target = fullUrl.searchParams.get("url");
        proxyUrl(target, {
          checkResolvedHost: (hostname) => checkResolvedHost(hostname, lookupAll),
        })
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
