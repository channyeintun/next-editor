// Pure string/JSON parser for a published Google Slides deck page
// (https://docs.google.com/presentation/d/e/…/pub). No DOM APIs — the page is
// scanned as text so it can run in tests and workers. Format details are
// undocumented Google internals; see google-slide-research.md §1.2/§1.5/§2.

import {
  GoogleSlidesParseError,
  type DeckStep,
  type DeckStepEntry,
  type DeckStepTrack,
  type ParsedDeck,
  type ParsedDeckSlide,
} from "./types";

const PUBLISHED_DECK_URL_PATTERN = /^https:\/\/docs\.google\.com\/presentation\/d\/e\/[^/]+\//;

/**
 * True for published-deck URLs (File → Share → Publish to web), i.e.
 * https://docs.google.com/presentation/d/e/<token>/… — an editor URL
 * (/presentation/d/<id>/edit) returns false.
 */
export function isPublishedDeckUrl(url: string): boolean {
  return PUBLISHED_DECK_URL_PATTERN.test(url);
}

const PUBLISH_HINT =
  "Check that the deck is published to the web (File → Share → Publish to web in Google Slides) and that you pasted the published link.";

/**
 * Extracts the JSON array following the literal `docData:` by bracket
 * matching. The page can be ~12 MB, so this deliberately scans forward from
 * the marker instead of regexing across the whole document. The simple
 * bracket counter is what the format tolerates: in practice the real pages
 * never put unbalanced brackets inside strings before docData's closing
 * bracket.
 */
function extractDocData(html: string): unknown {
  const marker = html.indexOf("docData:");
  if (marker === -1) {
    throw new GoogleSlidesParseError(
      `Could not find slide data (docData) in the page. ${PUBLISH_HINT}`,
    );
  }
  const start = html.indexOf("[", marker);
  if (start === -1) {
    throw new GoogleSlidesParseError(`Malformed slide data (docData) in the page. ${PUBLISH_HINT}`);
  }
  let depth = 0;
  for (let i = start; i < html.length; i++) {
    const ch = html.charCodeAt(i);
    if (ch === 91 /* [ */) depth++;
    else if (ch === 93 /* ] */) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as unknown;
        } catch {
          throw new GoogleSlidesParseError(
            `Could not parse slide data (docData) in the page. ${PUBLISH_HINT}`,
          );
        }
      }
    }
  }
  throw new GoogleSlidesParseError(`Truncated slide data (docData) in the page. ${PUBLISH_HINT}`);
}

/**
 * Decodes one SK_svgData payload: a single-quoted JS string literal whose
 * content uses \xNN hex escapes (e.g. \x3c for <). To resolve every escape in a
 * single consistent pass (the way an `eval` of the literal would, but without
 * running remote code), the \xNN escapes are rewritten to the equivalent JSON
 * \u00NN form and the whole thing is handed to one JSON.parse. Decoding \xNN to
 * a raw backslash first and re-parsing would corrupt payloads that contain a
 * literal backslash (\x5c) — the backslash would be misread as a fresh JSON
 * escape. `\'` is defanged since JSON forbids it (Google escapes quotes as
 * \x27, so this is only defensive). Everything before the first "<svg" (XML
 * prolog etc.) is dropped.
 */
function decodeSvgPayload(raw: string): string {
  const asJsonString = raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1").replace(/\\'/g, "'");
  let decoded: string;
  try {
    decoded = JSON.parse('"' + asJsonString + '"') as string;
  } catch {
    throw new GoogleSlidesParseError(`Could not decode a slide SVG in the page. ${PUBLISH_HINT}`);
  }
  const svgStart = decoded.indexOf("<svg");
  if (svgStart === -1) {
    throw new GoogleSlidesParseError(`A slide payload contained no SVG. ${PUBLISH_HINT}`);
  }
  return decoded.slice(svgStart);
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function convertTracks(rawTracks: unknown): DeckStepTrack[] {
  const tracks: DeckStepTrack[] = [];
  if (!Array.isArray(rawTracks)) return tracks;
  for (const x of rawTracks) {
    if (!Array.isArray(x)) continue;
    if (x[0] === 0) {
      tracks.push({
        kind: "opacity",
        from: asFiniteNumber(x[1]) ?? 0,
        to: asFiniteNumber(x[2]) ?? 0,
      });
    } else if (x[0] === 2) {
      tracks.push({
        kind: "scale",
        from: asFiniteNumber(x[2]) ?? 1,
        to: asFiniteNumber(x[3]) ?? 1,
      });
    } else if (x[0] === 3) {
      tracks.push({
        kind: "translate",
        fromX: asFiniteNumber(x[1]) ?? 0,
        fromY: asFiniteNumber(x[2]) ?? 0,
        toX: asFiniteNumber(x[3]) ?? 0,
        toY: asFiniteNumber(x[4]) ?? 0,
      });
    }
    // Unknown track kinds are ignored.
  }
  return tracks;
}

/**
 * Converts a slide's raw build-step data (docData[1][i][7][0]) into typed
 * steps. The raw shape is `[ step, … ]`, where each `step` holds its animation
 * entries at index 0 (i.e. `step[0] = [entry, …]`); each entry is
 * `[tracks, elementId, durationMs, delayMs, _, _, flag]`. Entries are skipped
 * when the flag (index 6) === 2 or when the target id is a page id (whole-slide
 * transition entries); steps with zero surviving entries are dropped. The data
 * may be missing or partial — treated defensively.
 */
function convertSteps(rawSteps: unknown, pageIds: ReadonlySet<string>): DeckStep[] {
  const steps: DeckStep[] = [];
  if (!Array.isArray(rawSteps)) return steps;
  for (const rawStep of rawSteps) {
    if (!Array.isArray(rawStep)) continue;
    const rawEntries = rawStep[0];
    if (!Array.isArray(rawEntries)) continue;
    const entries: DeckStepEntry[] = [];
    for (const entry of rawEntries) {
      if (!Array.isArray(entry)) continue;
      const elementId = entry[1];
      if (typeof elementId !== "string") continue;
      if (entry[6] === 2 || pageIds.has(elementId)) continue;
      entries.push({
        elementId,
        durationMs: Math.max(asFiniteNumber(entry[2]) ?? 0, 1),
        delayMs: asFiniteNumber(entry[3]) ?? 0,
        tracks: convertTracks(entry[0]),
      });
    }
    if (entries.length > 0) steps.push(entries);
  }
  return steps;
}

interface DocDataSlideInfo {
  title: string;
  rawSteps: unknown;
}

/**
 * Parses the HTML of a published Google Slides deck page into typed slide
 * data. Pure: string/JSON only, no DOM, no network. Throws
 * GoogleSlidesParseError on any structural mismatch.
 */
export function parsePublishedDeck(html: string, sourceUrl: string): ParsedDeck {
  const docData = extractDocData(html);
  if (!Array.isArray(docData)) {
    throw new GoogleSlidesParseError(
      `Unexpected slide data (docData) shape in the page. ${PUBLISH_HINT}`,
    );
  }
  const size = docData[0];
  const width = Array.isArray(size) ? asFiniteNumber(size[0]) : undefined;
  const height = Array.isArray(size) ? asFiniteNumber(size[1]) : undefined;
  if (width === undefined || height === undefined) {
    throw new GoogleSlidesParseError(`Missing deck dimensions in the page. ${PUBLISH_HINT}`);
  }

  // Page ids in presentation order.
  const pageIds = [...html.matchAll(/setPageData\('([^')]+)/g)].map((m) => m[1]);
  if (pageIds.length === 0) {
    throw new GoogleSlidesParseError(`Found no slides in the page. ${PUBLISH_HINT}`);
  }

  // One hex-escaped SVG payload per page id, in the same order. Google
  // hex-escapes every special byte as \xNN, so a payload never contains a raw
  // single quote — a plain [^'] run captures it up to the true closing quote
  // (an escape-aware pattern risks engine-dependent over-matching on the large
  // real payloads).
  const svgs = [...html.matchAll(/SK_svgData = '([^']+)'/g)].map((m) => decodeSvgPayload(m[1]));
  if (svgs.length !== pageIds.length) {
    throw new GoogleSlidesParseError(
      `Slide count mismatch in the page (${pageIds.length} pages, ${svgs.length} SVGs). ${PUBLISH_HINT}`,
    );
  }

  // docData[1][i] = [pageId, _, title, …] with raw build steps at [7][0].
  const pageIdSet = new Set(pageIds);
  const infoByPageId = new Map<string, DocDataSlideInfo>();
  const slideTuples = docData[1];
  if (Array.isArray(slideTuples)) {
    for (const tuple of slideTuples) {
      if (!Array.isArray(tuple) || typeof tuple[0] !== "string") continue;
      const stepsContainer = tuple[7];
      infoByPageId.set(tuple[0], {
        title: typeof tuple[2] === "string" ? tuple[2] : "",
        rawSteps: Array.isArray(stepsContainer) ? stepsContainer[0] : undefined,
      });
    }
  }

  const slides: ParsedDeckSlide[] = pageIds.map((pageId, i) => {
    const info = infoByPageId.get(pageId);
    return {
      pageId,
      title: info?.title ?? "",
      svg: svgs[i],
      steps: convertSteps(info?.rawSteps, pageIdSet),
    };
  });

  return { sourceUrl, width, height, slides };
}
