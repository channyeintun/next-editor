// Documents the Worker serves straight from Static Assets, fetched by the URL
// Static Assets serves each at. With `html_handling = "auto-trailing-slash"`
// (the default) that canonical URL is the only one it answers with a 200:
// others get a 307 to it, which ASSETS.fetch would hand on to the browser as
// an extra round trip.
//
// Kept free of Worker-only types and imports: build/landingPrerenderPlugin.ts
// imports LANDING_DOCUMENT_FILE from here to know where to write.

/** The minimal ASSETS binding these helpers need (a Fetcher in the Worker). */
export interface StaticAssets {
  fetch(request: Request): Promise<Response>;
}

/** The landing page, prerendered next to index.html by the client build. */
export const LANDING_DOCUMENT_FILE = "landing.html";

/** Where Static Assets serves LANDING_DOCUMENT_FILE. */
const LANDING_DOCUMENT_PATH = "/landing";

/**
 * Every URL Static Assets would answer with the prerendered landing (a 200 or
 * a 307 to it). The file is an implementation detail of `/`, so the Worker
 * keeps answering these the way it answers any path with no file.
 */
export const LANDING_DOCUMENT_URLS = [LANDING_DOCUMENT_PATH, "/landing/", "/landing.html"];

function fetchDocument(assets: StaticAssets, request: Request, path: string): Promise<Response> {
  // Same method and headers (If-None-Match included), only the path differs.
  return assets.fetch(new Request(new URL(path, request.url), request));
}

/**
 * The landing document, untouched: its ETag and Last-Modified survive, so a
 * conditional request can be answered with a 304. If a build ever lacks the
 * file, Static Assets' SPA fallback answers with index.html instead, and the
 * browser renders the landing page itself.
 */
export function serveLandingDocument(assets: StaticAssets, request: Request): Promise<Response> {
  return fetchDocument(assets, request, LANDING_DOCUMENT_PATH);
}

/** index.html, the same document the SPA fallback serves for a path with no file. */
export function serveAppShell(assets: StaticAssets, request: Request): Promise<Response> {
  return fetchDocument(assets, request, "/");
}
