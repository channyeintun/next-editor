import { dehydrate, QueryClient } from "@tanstack/react-query";
import { FIRST_LESSONS_PAGE, type LessonsPage } from "../../lessons/lessonsPages";
import { lessonKeys, primeLessonDetails } from "../../lessons/queryKeys";
import { FIRST_ROW_CARD_MEDIA } from "../../../tube/src/lib/galleryColumns";
import { resolveThumb } from "../../../tube/src/lib/links";
import { appendToHead, escapeAttribute, serverQueryStateScript } from "./documentHtml";
import { rewriteHtmlAsset } from "./rewriteHtmlAsset";

// Data-only SSR for the gallery (/learn), like the lesson page's: #root stays
// empty for the browser to render into. Without this the gallery's page 0 and
// its largest paint, the first row of thumbnails, are both discovered only
// after the route's JS has loaded and the client has made its own
// /api/lessons round trip. The document now carries page 0, dehydrated into
// the client's cache, and preloads the first row's thumbnails.

/**
 * The cache the client builds when it fetches page 0 itself: the infinite
 * query's first page, and every lesson on it under its detail key, which
 * useLessonsInfinite's queryFn primes (a hydrated query never runs it), so a
 * card click still resolves from cache.
 */
export function dehydrateGalleryFirstPage(page: LessonsPage) {
  const client = new QueryClient();
  client.setQueryData(lessonKeys.infinite, { pages: [page], pageParams: [FIRST_LESSONS_PAGE] });
  primeLessonDetails(client, page.lessons);
  const state = dehydrate(client);
  client.clear();
  return state;
}

/**
 * Preloads for the first row's thumbnails, each gated by the media query under
 * which its card is in that row (one card on a phone, up to four on a wide
 * screen). The preload is only reused if it matches the grid's own request: the
 * href is the src LessonCard builds (resolveThumb), and like that <img> it has
 * no crossorigin; fetchpriority matches the eager first-row tile too. A lesson
 * without a thumbnail shows an icon and requests nothing.
 */
export function firstRowThumbnailPreloads(page: LessonsPage): string {
  return page.lessons
    .slice(0, FIRST_ROW_CARD_MEDIA.length)
    .flatMap((lesson, index) => {
      if (!lesson.thumbnail) return [];
      const media = FIRST_ROW_CARD_MEDIA[index];
      return [
        `<link rel="preload" as="image" href="${escapeAttribute(resolveThumb(lesson.thumbnail))}" fetchpriority="high"${media ? ` media="${media}"` : ""} />`,
      ];
    })
    .join("\n    ");
}

export function injectGalleryDocument(document: string, page: LessonsPage): string {
  const preloads = firstRowThumbnailPreloads(page);
  return appendToHead(
    document,
    `${preloads ? `${preloads}\n    ` : ""}${serverQueryStateScript(dehydrateGalleryFirstPage(page))}`,
  );
}

export function renderGalleryResponse(
  assetResponse: Response,
  page: LessonsPage,
): Promise<Response> {
  return rewriteHtmlAsset(assetResponse, (document) => injectGalleryDocument(document, page));
}
