import { renderToString } from "react-dom/server.edge";
import { StaticRouter } from "react-router";
import LandingPage from "../../../src/components/LandingPage";
import { rewriteHtmlAsset } from "./rewriteHtmlAsset";

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

export function renderLandingResponse(assetResponse: Response): Promise<Response> {
  return rewriteHtmlAsset(assetResponse, (document) => injectLandingMarkup(document));
}
