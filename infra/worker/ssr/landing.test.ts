import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import LandingPage from "../../../src/components/LandingPage";
import { injectLandingMarkup, renderLandingMarkup, renderLandingResponse } from "./landing";

describe("landing page SSR", () => {
  it("renders crawlable landing-page content and navigation", () => {
    const markup = renderLandingMarkup();

    expect(markup).toContain("BUILD IT.");
    expect(markup).toContain("Turn real coding sessions into interactive tutorials");
    expect(markup).toContain('href="/code"');
    expect(markup).toContain('href="/learn"');
    expect(markup).toContain("Use Cases");
  });

  it("marks the injected root for browser hydration", () => {
    const document = injectLandingMarkup(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      "<main>Rendered</main>",
    );

    expect(document).toContain('<div id="root" data-ssr="landing"><main>Rendered</main></div>');
  });

  it("matches the browser data router's initial markup", () => {
    const router = createMemoryRouter([{ path: "/", element: createElement(LandingPage) }], {
      initialEntries: ["/"],
    });
    const browserMarkup = renderToString(createElement(RouterProvider, { router }));

    expect(browserMarkup).toBe(renderLandingMarkup());
  });

  it("injects HTML responses and drops stale representation headers", async () => {
    const assetResponse = new Response(
      '<!doctype html><html><body><div id="root"></div></body></html>',
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"static-index"',
          "last-modified": "Fri, 17 Jul 2026 00:00:00 GMT",
        },
      },
    );

    const response = await renderLandingResponse(assetResponse);
    const document = await response.text();

    expect(document).toContain('data-ssr="landing"');
    expect(document).toContain("Turn real coding sessions into interactive tutorials");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("last-modified")).toBeNull();
  });

  it("preserves non-HTML asset responses", async () => {
    const assetResponse = new Response("not html", {
      headers: { "content-type": "text/plain" },
    });

    await expect(renderLandingResponse(assetResponse)).resolves.toBe(assetResponse);
  });
});
