// Same-origin proxy for the OpenRouter Agent SDK's `callModel()` calls.
//
// Why this exists: `@openrouter/agent`'s `callModel()` unconditionally injects
// an `x-openrouter-callmodel: true` header on every request it makes (see
// node_modules/@openrouter/agent/esm/inner-loop/call-model.js). OpenRouter's
// `POST /api/v1/responses` endpoint doesn't list that header in the
// `Access-Control-Allow-Headers` of its CORS preflight response, so calling it
// directly from the browser fails outright:
//
//   Access to fetch at 'https://openrouter.ai/api/v1/responses' from origin
//   '...' has been blocked by CORS policy: Request header field
//   x-openrouter-callmodel is not allowed by Access-Control-Allow-Headers.
//
// Routing the call through this same-origin endpoint instead sidesteps the
// browser's CORS check entirely (same-origin requests aren't preflighted).
// This module's own outbound `fetch` to openrouter.ai runs server-to-server
// (Worker or Vite dev-server middleware), which is never subject to CORS.
//
// BYOK is preserved: the user's own OpenRouter API key travels in the
// forwarded `Authorization` header and is only ever read into memory for the
// duration of this one request — never logged or persisted here. See
// `src/agent/openrouterClient.ts` for the client-side `serverURL` wiring and
// `src/agent/credentials.ts` for how the key itself is stored.
//
// Shared by both the Vite dev-server middleware
// (tube/vite/openrouterProxyPlugin.ts) and the Cloudflare Worker route
// (infra/worker/routes/openrouter.ts) so the forwarding logic is written
// once. It only uses the Web-standard fetch/Request/Response/Headers APIs,
// available in both.
//
// Unlike src/shared/proxy.ts (which proxies arbitrary caller-supplied https
// URLs and needs an SSRF host allowlist), this proxy's destination is a
// single hardcoded OpenRouter endpoint, so there's no user-controlled target
// to validate.

const OPENROUTER_RESPONSES_URL = "https://openrouter.ai/api/v1/responses";

// Hop-by-hop / connection-specific headers that must not be copied through to
// the upstream request, plus headers that only make sense on the original
// browser->this-origin hop.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "origin",
  "referer",
  "content-length",
  "connection",
  "cookie",
  "cf-connecting-ip",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

// Headers from the upstream response that must not be copied back verbatim:
// hop-by-hop headers, and OpenRouter's own CORS headers (irrelevant here
// since the browser talks to this same-origin endpoint, not to openrouter.ai
// directly).
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "transfer-encoding",
  "access-control-allow-origin",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-credentials",
]);

/**
 * Forwards a `POST /responses` request to OpenRouter's Responses API,
 * streaming the (possibly SSE) response body straight through so the agent
 * SDK's streaming consumption patterns keep working.
 */
export async function proxyOpenRouterResponses(request: Request): Promise<Response> {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENROUTER_RESPONSES_URL, {
      method: "POST",
      headers,
      body: request.body,
      // Required by undici/Workers when the request body is a stream.
      duplex: "half",
    } as RequestInit);
  } catch (cause) {
    return new Response(JSON.stringify({ error: `Upstream fetch failed: ${String(cause)}` }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers) {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
