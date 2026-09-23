import { afterEach, describe, expect, it, vi } from "vitest";
import { proxyOpenRouterResponses } from "./openrouterProxy";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUpstream() {
  const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

describe("proxyOpenRouterResponses", () => {
  // The SPA calls this route same-origin, so it arrives carrying everything the
  // app stamps on its own requests: PostHog's tracing headers (the distinct id
  // is the signed-in user's id), cookies, Cloudflare's client metadata. Only
  // what OpenRouter's Responses API reads may leave for openrouter.ai.
  it("forwards OpenRouter's headers and nothing the app stamped on the request", async () => {
    const upstream = stubUpstream();

    await proxyOpenRouterResponses(
      new Request("https://nexteditor.dev/api/openrouter/responses", {
        method: "POST",
        body: "{}",
        headers: {
          Authorization: "Bearer sk-or-key",
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "HTTP-Referer": "https://nexteditor.dev",
          "X-OpenRouter-Title": "Next Editor",
          "x-openrouter-callmodel": "true",
          "X-POSTHOG-DISTINCT-ID": "user-1",
          "X-POSTHOG-SESSION-ID": "session-1",
          "X-POSTHOG-WINDOW-ID": "window-1",
          Cookie: "ne_session=secret",
          "CF-IPCountry": "MM",
        },
      }),
    );

    const sent = new Headers(upstream.mock.calls[0][1].headers);
    expect(Object.fromEntries(sent)).toEqual({
      authorization: "Bearer sk-or-key",
      "content-type": "application/json",
      accept: "text/event-stream",
      "http-referer": "https://nexteditor.dev",
      "x-openrouter-title": "Next Editor",
      "x-openrouter-callmodel": "true",
    });
  });
});
