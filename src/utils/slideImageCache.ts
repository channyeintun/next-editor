// Imported slide images, fetched once by the page and handed to slide frames as
// data: URLs.
//
// Each slide renders in a srcdoc frame sandboxed without allow-same-origin, so
// every mount gets a fresh opaque origin. Chromium never serves an opaque frame's
// subresources from the HTTP cache (its network isolation key is transient) or
// from the memory cache (a different requesting origin), so every display of a
// slide downloaded its images again, and the slide swap waited for them:
// BufferedSlideContent promotes a slide on load. how-next-editor-works-mm
// fetched one 360 KB background ~30 times per playthrough. The page fetches with
// its own origin, where the HTTP cache works, and keeps the result in memory.
//
// Render-time only: the stored deck keeps its /media hrefs (see
// proxyImageHrefs.ts for why it is not inlined there).

/** The same-origin image targets proxyImageHrefs.ts rewrites imported hrefs to. */
const INLINABLE_HREF = /^\/(?:media\/|api\/proxy\?)[^&]*$/;

/** Every href/xlink:href value in markup. */
const HREF_PATTERN = /(?:xlink:)?href\s*=\s*(["'])([^"']*)\1/gi;

/** The image types the slide sanitizer accepts as data: URLs; others keep their href. */
const INLINABLE_TYPE = /^image\/(?:png|gif|jpe?g|webp|avif|svg\+xml)$/i;

/** Bounds memory when one deck holds unusually many or large images. */
const MAX_CACHED_CHARS = 48 * 1024 * 1024;

interface CachedImage {
  /** The data: URL; null when the image cannot be inlined; undefined while loading. */
  dataUrl?: string | null;
  loaded: Promise<void>;
}

const cache = new Map<string, CachedImage>();
let cachedChars = 0;

async function fetchAsDataUrl(href: string): Promise<string | null> {
  try {
    const response = await fetch(href);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!INLINABLE_TYPE.test(blob.type)) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function forget(href: string, entry: CachedImage): void {
  cache.delete(href);
  cachedChars -= entry.dataUrl?.length ?? 0;
}

function evictOverflow(): void {
  // Oldest first. A mounted slide keeps its own copy inside its srcdoc.
  for (const [href, entry] of cache) {
    if (cachedChars <= MAX_CACHED_CHARS) return;
    if (entry.dataUrl) forget(href, entry);
  }
}

function requestImage(href: string): CachedImage {
  const cached = cache.get(href);
  if (cached) return cached;
  const entry: CachedImage = {
    loaded: fetchAsDataUrl(href).then((dataUrl) => {
      entry.dataUrl = dataUrl;
      // Evicted while loading (the deck changed): the caller still gets it, the cache does not.
      if (cache.get(href) !== entry) return;
      cachedChars += dataUrl?.length ?? 0;
      evictOverflow();
    }),
  };
  cache.set(href, entry);
  return entry;
}

function collect(hrefs: readonly string[], entries: readonly CachedImage[]) {
  const images = new Map<string, string>();
  entries.forEach((entry, index) => {
    if (entry.dataUrl) images.set(hrefs[index], entry.dataUrl);
  });
  return images;
}

/** The distinct image hrefs in slide markup that {@link loadSlideImages} can inline. */
export function inlinableSlideImageHrefs(content: string): string[] {
  const hrefs = new Set<string>();
  for (const match of content.matchAll(HREF_PATTERN)) {
    if (INLINABLE_HREF.test(match[2])) hrefs.add(match[2]);
  }
  return [...hrefs];
}

/** The data: URL for each href, or null while any of them is still loading. */
export function peekSlideImages(hrefs: readonly string[]): ReadonlyMap<string, string> | null {
  const entries: CachedImage[] = [];
  for (const href of hrefs) {
    const entry = cache.get(href);
    if (entry?.dataUrl === undefined) return null;
    entries.push(entry);
  }
  return collect(hrefs, entries);
}

/**
 * Fetches each href once and resolves with its data: URL. An href that failed or
 * is not an inlinable image is left out, so the frame falls back to loading it.
 */
export async function loadSlideImages(
  hrefs: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const entries = hrefs.map(requestImage);
  await Promise.all(entries.map((entry) => entry.loaded));
  return collect(hrefs, entries);
}

/** Drops every cached image except `hrefs`, the images of the deck now shown. */
export function retainSlideImages(hrefs: Iterable<string>): void {
  const kept = new Set(hrefs);
  for (const [href, entry] of cache) {
    if (!kept.has(href)) forget(href, entry);
  }
}
