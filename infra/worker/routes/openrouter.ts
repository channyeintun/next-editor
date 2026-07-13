import { Hono } from "hono";
import type { Env } from "../env";
import { proxyOpenRouterResponses } from "../../../src/shared/openrouterProxy";

// Mounted at /api/openrouter in worker/index.ts. See
// src/shared/openrouterProxy.ts for why this exists (CORS on the
// `x-openrouter-callmodel` header @openrouter/agent's callModel() always
// sends) and the shared forwarding logic. The Vite dev-server equivalent is
// tube/vite/openrouterProxyPlugin.ts.
export const openrouterRoute = new Hono<{ Bindings: Env }>();

openrouterRoute.post("/responses", (c) => proxyOpenRouterResponses(c.req.raw));
