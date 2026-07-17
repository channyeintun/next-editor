import { renderToString } from "react-dom/server.edge";
import { StaticRouter } from "react-router";
import LandingPage from "../../../src/components/LandingPage";

const EMPTY_ROOT = '<div id="root"></div>';
let cachedLandingMarkup: string | undefined;

export function renderLandingMarkup(): string {
  cachedLandingMarkup ??= renderToString(
    <StaticRouter location="/">
      <LandingPage />
    </StaticRouter>,
  );
  return cachedLandingMarkup;
}

export function injectLandingMarkup(document: string, markup = renderLandingMarkup()): string {
  if (!document.includes(EMPTY_ROOT)) {
    return document;
  }

  return document.replace(EMPTY_ROOT, `<div id="root" data-ssr="landing">${markup}</div>`);
}

export async function renderLandingResponse(assetResponse: Response): Promise<Response> {
  const contentType = assetResponse.headers.get("content-type");
  if (!assetResponse.ok || !contentType?.includes("text/html")) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  // The body differs from the static asset, so representation-specific headers
  // from ASSETS.fetch must not describe the rendered document.
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("last-modified");

  return new Response(injectLandingMarkup(await assetResponse.text()), {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}
