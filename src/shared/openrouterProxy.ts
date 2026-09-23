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

// The request headers OpenRouter's Responses API reads, as @openrouter/sdk
// sends them: the user's key, the body and stream negotiation, app attribution
// (HTTP-Referer) and OpenRouter's own X-OpenRouter-* headers (title,
// categories, metadata, and the x-openrouter-callmodel marker this proxy exists
// for). Everything else stays on the browser->this-origin hop. The request is
// same-origin, so it also carries what the app stamps on its own traffic:
// cookies, Cloudflare's client metadata, and PostHog's X-POSTHOG-* tracing
// headers, whose distinct id is the signed-in user's id. A denylist let those
// through to openrouter.ai; an allow-list cannot leak a header added later.
const FORWARDED_REQUEST_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "http-referer",
]);
const FORWARDED_REQUEST_HEADER_PREFIX = "x-openrouter-";

function isForwardedRequestHeader(name: string): boolean {
  const key = name.toLowerCase();
  return FORWARDED_REQUEST_HEADERS.has(key) || key.startsWith(FORWARDED_REQUEST_HEADER_PREFIX);
}

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
    if (isForwardedRequestHeader(key)) {
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
