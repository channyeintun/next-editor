import { dehydrate, QueryClient } from "@tanstack/react-query";
import {
  FIRST_GALLERY_PAGE,
  galleryItemThumbnail,
  galleryLessons,
  type GalleryPage,
} from "../../lessons/galleryPages";
import { lessonKeys, primeLessonDetails } from "../../lessons/queryKeys";
import { FIRST_ROW_CARD_MEDIA } from "../../../tube/src/lib/galleryColumns";
import { resolveThumb } from "../../../tube/src/lib/links";
import { appendToHead, escapeAttribute, serverQueryStateScript } from "./documentHtml";
import { rewriteHtmlAsset } from "./rewriteHtmlAsset";

// Data-only SSR for the gallery (/learn), like the lesson page's: #root stays
// empty for the browser to render into. Without this the gallery's page 0 and
// its largest paint, the first row of thumbnails, are both discovered only
// after the route's JS has loaded and the client has made its own
// /api/gallery round trip. The document now carries page 0, dehydrated into
// the client's cache, and preloads the first row's thumbnails.

/**
 * The cache the client builds when it fetches page 0 itself: the infinite
 * query's first page, and every lesson card on it under its detail key, which
 * useLessonsInfinite's queryFn primes (a hydrated query never runs it), so a
 * card click still resolves from cache.
 */
export function dehydrateGalleryFirstPage(page: GalleryPage) {
  const client = new QueryClient();
  client.setQueryData(lessonKeys.infinite, { pages: [page], pageParams: [FIRST_GALLERY_PAGE] });
  primeLessonDetails(client, galleryLessons(page.items));
  const state = dehydrate(client);
  client.clear();
  return state;
}

/**
 * Preloads for the first row's thumbnails, each gated by the media query under
 * which its card is in that row (one card on a phone, up to four on a wide
 * screen). The preload is only reused if it matches the grid's own request: the
 * href is the src the card builds (resolveThumb, for a lesson's thumbnail and a
 * playlist's cover alike), and like that <img> it has no crossorigin;
 * fetchpriority matches the eager first-row tile too. A card without a
 * thumbnail shows an icon and requests nothing.
 */
export function firstRowThumbnailPreloads(page: GalleryPage): string {
  return page.items
    .slice(0, FIRST_ROW_CARD_MEDIA.length)
    .flatMap((item, index) => {
      const thumbnail = galleryItemThumbnail(item);
      if (!thumbnail) return [];
      const media = FIRST_ROW_CARD_MEDIA[index];
      return [
        `<link rel="preload" as="image" href="${escapeAttribute(resolveThumb(thumbnail))}" fetchpriority="high"${media ? ` media="${media}"` : ""} />`,
      ];
    })
    .join("\n    ");
}

export function injectGalleryDocument(document: string, page: GalleryPage): string {
  const preloads = firstRowThumbnailPreloads(page);
  return appendToHead(
    document,
    `${preloads ? `${preloads}\n    ` : ""}${serverQueryStateScript(dehydrateGalleryFirstPage(page))}`,
  );
}

export function renderGalleryResponse(
  assetResponse: Response,
  page: GalleryPage,
): Promise<Response> {
  return rewriteHtmlAsset(assetResponse, (document) => injectGalleryDocument(document, page));
}
