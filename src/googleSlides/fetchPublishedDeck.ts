import { GoogleSlidesParseError, type ParsedDeck } from "./types";
import { isPublishedDeckUrl, parsePublishedDeck } from "./parse";
import { normalizeSvg } from "./normalizeSvg";
import { storeImageHrefs } from "./storeImageHrefs";

const EDITOR_URL_PATTERN = /^https:\/\/docs\.google\.com\/presentation\/d\/(?!e\/)[^/]+/;

/** Strips query string and hash from a URL. */
function stripUrlTail(url: string): string {
  return url.split("#", 1)[0].split("?", 1)[0];
}

/**
 * Fetches a published Google Slides deck page and parses it into typed slide
 * data, with each SVG normalized for inline injection and any Google-hosted
 * image hrefs (blocked from direct cross-origin loading by Google's
 * Cross-Origin-Resource-Policy header) rewritten to a same-origin URL:
 * preferably an R2-backed /media/ path stored once at import time
 * (storeImageHrefs.ts), falling back to the live /api/proxy route
 * (proxyImageHrefs.ts) when ingestion is unavailable. Deliberately not
 * inlined as data: URLs — that would bloat every persisted slide by the
 * image's full base64 size.
 *
 * The deck must be published via File → Share → Publish to web; a normal editor
 * URL (/presentation/d/<id>/edit) is rejected with a hint to publish it first.
 * Relies on Google reflecting the request Origin (CORS) on published pages, so
 * no proxy or auth is involved for the deck page fetch itself.
 */
export async function fetchPublishedDeck(url: string): Promise<ParsedDeck> {
  const trimmed = url.trim();

  if (!isPublishedDeckUrl(trimmed)) {
    if (EDITOR_URL_PATTERN.test(trimmed)) {
      throw new GoogleSlidesParseError(
        "That looks like a Google Slides editor link. Open the deck, choose File → Share → Publish to web, and paste the published link (it contains /d/e/…).",
      );
    }
    throw new GoogleSlidesParseError(
      "Enter a published Google Slides link (File → Share → Publish to web), e.g. https://docs.google.com/presentation/d/e/…/pub.",
    );
  }

  const sourceUrl = stripUrlTail(trimmed);

  let response: Response;
  try {
    response = await fetch(sourceUrl);
  } catch (cause) {
    throw new GoogleSlidesParseError(
      `Could not reach the published deck. Check the link and your connection. (${String(cause)})`,
    );
  }

  if (!response.ok) {
    throw new GoogleSlidesParseError(
      `The published deck could not be loaded (HTTP ${response.status}). Make sure it is still published to the web.`,
    );
  }

  const html = await response.text();
  const deck = parsePublishedDeck(html, sourceUrl);

  const svgs = await storeImageHrefs(deck.slides.map((slide) => normalizeSvg(slide.svg)));

  return {
    ...deck,
    slides: deck.slides.map((slide, index) => ({ ...slide, svg: svgs[index] })),
  };
}
