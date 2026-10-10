import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server.edge";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vite-plus/test";
import { landingPrerenderPlugin } from "../../../build/landingPrerenderPlugin";
import LandingPage from "../../../src/components/LandingPage";
import {
  buildLandingDocument,
  injectLandingFontPreloads,
  injectLandingMarkup,
  renderLandingMarkup,
} from "./landing";
import { LANDING_DOCUMENT_FILE } from "./staticDocuments";

const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");

type WriteBundle = (
  this: unknown,
  options: { dir?: string },
  bundle: Record<string, { type: string; source?: string }>,
) => Promise<void>;

/** Runs the client build's prerender step against `shell` and returns what it wrote. */
async function prerenderFromShell(shell: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "landing-prerender-"));
  try {
    const writeBundle = landingPrerenderPlugin().writeBundle as WriteBundle;
    await writeBundle.call({}, { dir }, { "index.html": { type: "asset", source: shell } });
    return readFileSync(join(dir, LANDING_DOCUMENT_FILE), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  it("builds the landing document from the app shell", () => {
    const document = buildLandingDocument(repoFile("index.html"));

    expect(document).toContain('<div id="root" data-ssr="landing">');
    expect(document).toContain("Turn real coding sessions into interactive tutorials");
    expect(document).toBe(
      injectLandingFontPreloads(injectLandingMarkup(repoFile("index.html"), renderLandingMarkup())),
    );
  });

  it("is written beside index.html by the client build", async () => {
    const shell = repoFile("index.html");

    expect(await prerenderFromShell(shell)).toBe(buildLandingDocument(shell));
  });

  it("fails the build rather than write a landing page without its markup", async () => {
    await expect(prerenderFromShell("<html><body><main></main></body></html>")).rejects.toThrow(
      "no empty #root",
    );
  });

  it("preloads the hero fonts at the top of the landing document's head", () => {
    const document = buildLandingDocument(repoFile("index.html"));

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
});
