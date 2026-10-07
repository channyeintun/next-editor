import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import LandingPage from "../../../src/components/LandingPage";
import {
  injectLandingFontPreloads,
  injectLandingMarkup,
  renderLandingMarkup,
  renderLandingResponse,
} from "./landing";

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

function fontPreloadHrefs(document: string): string[] {
  return [...document.matchAll(/<link rel="preload" href="([^"]+)" as="font"[^>]*>/g)].map(
    (match) => match[1],
  );
}

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

  it("preloads the hero fonts at the top of the landing document's head", async () => {
    const response = await renderLandingResponse(
      new Response(repoFile("index.html"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    const document = await response.text();

    expect(fontPreloadHrefs(document)).toEqual([
      "/fonts/pp-neue-machina-inktrap-ultrabold.woff2",
      "/fonts/pp-telegraf-regular.woff2",
    ]);
    // Fonts are fetched in CORS mode; a preload without crossorigin is wasted.
    expect(document).toContain(
      '<link rel="preload" href="/fonts/pp-telegraf-regular.woff2" as="font" type="font/woff2" crossorigin />',
    );
    // Ahead of the entry script, so they are not queued behind its modulepreloads.
    expect(document.indexOf('as="font"')).toBeLessThan(document.indexOf('<script type="module"'));
  });

  it("preloads font urls that src/index.css actually declares", () => {
    const css = repoFile("src/index.css");
    const hrefs = fontPreloadHrefs(
      injectLandingFontPreloads('<html><head><meta charset="UTF-8" /></head></html>'),
    );

    expect(hrefs).toHaveLength(2);
    for (const href of hrefs) {
      expect(css).toContain(`src: url("${href}") format("woff2")`);
    }
  });

  it("leaves the shared index.html without font preloads", () => {
    expect(fontPreloadHrefs(repoFile("index.html"))).toEqual([]);
  });

  it("preserves non-HTML asset responses", async () => {
    const assetResponse = new Response("not html", {
      headers: { "content-type": "text/plain" },
    });

    await expect(renderLandingResponse(assetResponse)).resolves.toBe(assetResponse);
  });
});
