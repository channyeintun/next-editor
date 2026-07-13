import { OpenRouter } from "@openrouter/agent";

/**
 * The OpenRouter agent SDK talks to the API entirely over `fetch`, so it runs
 * client-side. The key is the user's own OpenRouter key (BYOK), held in memory
 * unless they opt into persistence — see `credentials.ts`.
 *
 * Requests are routed through this app's own `/api/openrouter` endpoint
 * rather than straight to openrouter.ai: `callModel()` unconditionally adds
 * an `x-openrouter-callmodel` header that OpenRouter's CORS preflight
 * response doesn't allow, which makes a direct browser call fail outright.
 * The proxy forwards the request server-to-server (see
 * src/shared/openrouterProxy.ts); the API key still only ever travels in the
 * Authorization header and isn't read or stored by the proxy.
 */
export function createOpenRouterClient(apiKey: string): OpenRouter {
  return new OpenRouter({ apiKey, serverURL: `${window.location.origin}/api/openrouter` });
}
