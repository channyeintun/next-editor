import { renderToString } from "react-dom/server.edge";
import { StaticRouter } from "react-router";
import LandingPage from "../../../src/components/LandingPage";

// The public landing page as the Worker serves it at `/`: index.html with the
// page's markup in #root, so crawlers and answer engines receive its semantic
// content in the initial HTML, and the browser hydrates it (src/main.tsx). The
// markup depends on nothing in the request, so it is rendered once, by the
// client build (build/landingPrerenderPlugin.ts), not per request: React's
// server renderer stays out of the Worker bundle, and the Worker serves the
// result as a plain static asset (staticDocuments.ts).

const EMPTY_ROOT = '<div id="root"></div>';

// The hero headline (Machina) and copy (Telegraf Regular) are
// `font-display: block`, and without a hint the browser only requests them
// once the render-blocking stylesheet has arrived and been applied, behind the
// entry's modulepreloads: the landing's LCP text stays invisible until then.
// Preloading them from this document starts both downloads at HTML parse. Not
// in index.html: that shell also serves /code and /learn/:slug, which never
// use these faces. The hrefs must match src/index.css's @font-face urls, and
// `crossorigin` is required because fonts are always fetched in CORS mode.
const LANDING_FONT_PRELOADS = [
  "/fonts/pp-neue-machina-inktrap-ultrabold.woff2",
  "/fonts/pp-telegraf-regular.woff2",
]
  .map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`)
  .join("\n    ");

export function renderLandingMarkup(): string {
  return renderToString(
    <StaticRouter location="/">
      <LandingPage />
    </StaticRouter>,
  );
}

export function injectLandingMarkup(document: string, markup = renderLandingMarkup()): string {
  if (!document.includes(EMPTY_ROOT)) {
    return document;
  }

  return document.replace(EMPTY_ROOT, `<div id="root" data-ssr="landing">${markup}</div>`);
}

/** Right after the charset declaration, ahead of the entry script and its modulepreloads. */
export function injectLandingFontPreloads(document: string): string {
  return document.replace(
    /<meta charset[^>]*>/i,
    (charset) => `${charset}\n    ${LANDING_FONT_PRELOADS}`,
  );
}

/** The landing document built from the app shell (the built index.html). */
export function buildLandingDocument(shell: string, markup = renderLandingMarkup()): string {
  return injectLandingFontPreloads(injectLandingMarkup(shell, markup));
}
