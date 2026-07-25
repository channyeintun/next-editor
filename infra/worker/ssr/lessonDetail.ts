import { dehydrate, QueryClient } from "@tanstack/react-query";
import type { Lesson } from "../../../tube/src/types";

// Data-only SSR. The lesson *page* is the editor — Monaco, WebContainers, the
// whole provider stack — and none of that renders on a Worker, so #root is
// deliberately left empty for the browser to mount into. What the edge can do
// is resolve the row: the document ships with real per-lesson metadata for
// crawlers, and with the same row dehydrated into React Query's cache so the
// browser never re-fetches what the server already looked up.
//
// Keep this string-based rather than HTMLRewriter: it has to be unit-testable
// in the worker suite's plain node environment.

/** Where the dehydrated React Query cache is parked for the client to pick up. */
export const QUERY_STATE_ELEMENT_ID = "__NE_QUERY_STATE__";

/** Must stay identical to useLesson()'s key in tube/src/hooks/useLessons.ts. */
export function lessonDetailQueryKey(slug: string): readonly [string, string, string] {
  return ["lessons", "detail", slug];
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `</script>` anywhere inside a JSON payload would close the tag early and turn
// the rest of the lesson into markup. Escaping "<" (plus the two line
// separators older parsers choke on) keeps the payload inert and still-valid
// JSON.
function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Every String.replace below passes its replacement as a FUNCTION, never as a
// string. A replacement string honours `$&`, `` $` ``, `$'` and `$1` as
// substitution patterns, and the values spliced in here (lesson title and
// description) are attacker-authored: the HTML escapers deliberately leave `$`
// alone, so a title of `$'$'$'$'` made each pass re-insert the rest of the
// document, and injectLessonDocument runs eight such passes over each other's
// output. A 12-character title reached gigabytes, which is not a throw the
// caller's try/catch can catch — the isolate is killed and takes co-resident
// requests with it. The function form has no substitution semantics at all.
function appendToHead(document: string, html: string): string {
  return document.includes("</head>")
    ? document.replace("</head>", () => `${html}\n  </head>`)
    : document;
}

// The static index.html writes its meta tags across several lines, so match on
// the attribute rather than a fixed tag string. Replaces in place when the tag
// exists (keeping document order sensible) and appends otherwise.
function setMeta(
  document: string,
  attribute: "name" | "property",
  key: string,
  content: string,
): string {
  const tag = `<meta ${attribute}="${key}" content="${escapeAttribute(content)}" />`;
  const pattern = new RegExp(`<meta[^>]*\\s${attribute}="${escapeRegExp(key)}"[^>]*>`, "i");
  return pattern.test(document)
    ? document.replace(pattern, () => tag)
    : appendToHead(document, tag);
}

function removeMeta(document: string, attribute: "name" | "property", key: string): string {
  const pattern = new RegExp(`\\s*<meta[^>]*\\s${attribute}="${escapeRegExp(key)}"[^>]*>`, "i");
  return document.replace(pattern, "");
}

function setTitle(document: string, title: string): string {
  return document.replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeText(title)}</title>`);
}

function setCanonical(document: string, href: string): string {
  const tag = `<link rel="canonical" href="${escapeAttribute(href)}" />`;
  const pattern = /<link[^>]*\srel="canonical"[^>]*>/i;
  return pattern.test(document)
    ? document.replace(pattern, () => tag)
    : appendToHead(document, tag);
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function imageMimeType(path: string): string | null {
  // Object.hasOwn: a thumbnail path ending `.constructor` would otherwise
  // resolve through the prototype chain to a function, which `?? null` does not
  // catch, and land in an og:image:type meta tag.
  const extension = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(path)?.[1]?.toLowerCase();
  if (!extension || !Object.hasOwn(IMAGE_MIME_TYPES, extension)) {
    return null;
  }
  return IMAGE_MIME_TYPES[extension];
}

// "4:12" → "PT4M12S", "1:02:03" → "PT1H2M3S". Google's Course rich result wants
// an ISO 8601 duration for courseWorkload; anything unparseable is dropped
// rather than guessed at.
export function toIsoDuration(duration: string | undefined): string | null {
  if (!duration) {
    return null;
  }

  const parts = duration.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const [hours, minutes, seconds] =
    parts.length === 3 ? parts.map(Number) : [0, ...parts.map(Number)];

  const encoded = [
    hours ? `${hours}H` : "",
    minutes ? `${minutes}M` : "",
    seconds ? `${seconds}S` : "",
  ].join("");
  return encoded ? `PT${encoded}` : null;
}

/** Media on a lesson row is stored site-relative ("media/lessons/…"); crawlers need absolute. */
function absoluteMediaUrl(origin: string, path: string): string {
  return `${origin}/${path.replace(/^\/+/, "")}`;
}

export function buildLessonJsonLd(lesson: Lesson, origin: string, canonicalUrl: string) {
  const workload = toIsoDuration(lesson.duration);

  return {
    "@context": "https://schema.org",
    "@type": "Course",
    "@id": `${canonicalUrl}#course`,
    name: lesson.title,
    description: lesson.description,
    url: canonicalUrl,
    image: absoluteMediaUrl(origin, lesson.thumbnail),
    inLanguage: "en",
    isAccessibleForFree: true,
    ...(lesson.tags?.length ? { keywords: lesson.tags.join(", ") } : {}),
    ...(lesson.publishedAt ? { datePublished: lesson.publishedAt } : {}),
    ...(lesson.author ? { author: { "@type": "Person", name: lesson.author } } : {}),
    provider: { "@type": "Organization", name: "Next Editor", url: origin },
    hasCourseInstance: {
      "@type": "CourseInstance",
      courseMode: "online",
      ...(workload ? { courseWorkload: workload } : {}),
    },
  };
}

/**
 * Dehydrated React Query cache carrying exactly the query the detail route is
 * about to run. `slug` is the one from the URL rather than `lesson.slug` so the
 * key matches what useParams() hands useLesson(), even if a lookup ever
 * resolves a slug that isn't byte-identical to the row's.
 */
export function dehydrateLessonDetail(slug: string, lesson: Lesson | null) {
  const client = new QueryClient();
  client.setQueryData(lessonDetailQueryKey(slug), lesson);
  const state = dehydrate(client);
  client.clear();
  return state;
}

function queryStateScript(slug: string, lesson: Lesson | null): string {
  const payload = serializeForScript(dehydrateLessonDetail(slug, lesson));
  return `<script type="application/json" id="${QUERY_STATE_ELEMENT_ID}">${payload}</script>`;
}

export interface LessonDocumentContext {
  lesson: Lesson;
  slug: string;
  origin: string;
}

export function injectLessonDocument(
  document: string,
  { lesson, slug, origin }: LessonDocumentContext,
): string {
  const canonicalUrl = `${origin}/learn/${slug}`;
  const imageUrl = absoluteMediaUrl(origin, lesson.thumbnail);
  const imageType = imageMimeType(lesson.thumbnail);

  let next = setTitle(document, `${lesson.title} | Next Editor`);
  next = setMeta(next, "name", "description", lesson.description);
  next = setCanonical(next, canonicalUrl);

  next = setMeta(next, "property", "og:type", "article");
  next = setMeta(next, "property", "og:url", canonicalUrl);
  next = setMeta(next, "property", "og:title", lesson.title);
  next = setMeta(next, "property", "og:description", lesson.description);
  next = setMeta(next, "property", "og:image", imageUrl);
  next = setMeta(next, "property", "og:image:alt", lesson.title);
  // The shell's width/height (and type) describe the 1024×1024 logo it ships
  // with. A thumbnail is a different asset entirely, and wrong dimensions are
  // worse than absent ones.
  next = removeMeta(next, "property", "og:image:width");
  next = removeMeta(next, "property", "og:image:height");
  next = imageType
    ? setMeta(next, "property", "og:image:type", imageType)
    : removeMeta(next, "property", "og:image:type");

  next = setMeta(next, "name", "twitter:card", "summary_large_image");
  next = setMeta(next, "name", "twitter:title", lesson.title);
  next = setMeta(next, "name", "twitter:description", lesson.description);
  next = setMeta(next, "name", "twitter:image", imageUrl);
  next = setMeta(next, "name", "twitter:image:alt", lesson.title);

  const jsonLd = serializeForScript(buildLessonJsonLd(lesson, origin, canonicalUrl));

  return appendToHead(
    next,
    `<script type="application/ld+json">${jsonLd}</script>\n    ${queryStateScript(slug, lesson)}`,
  );
}

export async function renderLessonDetailResponse(
  assetResponse: Response,
  context: LessonDocumentContext,
): Promise<Response> {
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

  return new Response(injectLessonDocument(await assetResponse.text(), context), {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

/**
 * An unknown slug still serves the SPA shell (the client renders its own
 * "Lesson not found"), but with a 404 status and noindex so a mistyped or
 * deleted lesson can't enter the index as a soft 404. The miss is dehydrated
 * too — findLessonBySlug() resolves `null` for "no such lesson", so the client
 * can render that verdict immediately instead of spinning through a lookup the
 * edge already did.
 */
export async function renderMissingLessonResponse(
  assetResponse: Response,
  slug: string,
): Promise<Response> {
  const contentType = assetResponse.headers.get("content-type");
  if (!assetResponse.ok || !contentType?.includes("text/html")) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  headers.delete("last-modified");

  const document = appendToHead(
    setMeta(await assetResponse.text(), "name", "robots", "noindex,follow"),
    queryStateScript(slug, null),
  );
  return new Response(document, { status: 404, statusText: "Not Found", headers });
}
