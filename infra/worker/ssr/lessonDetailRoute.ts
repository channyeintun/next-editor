import type { Lesson } from "../../lessons/types";
import type { Env } from "../env";
import { findPublishedLessonBySlug } from "../lessonCatalog";
import { renderLessonDetailResponse, renderMissingLessonResponse } from "./lessonDetail";
import { serveAppShell } from "./staticDocuments";

// A failed lookup is not a missing lesson: only a lookup that succeeded and
// found nothing may answer 404 + noindex. A D1 hiccup must never tell crawlers
// to drop a real lesson, nor dehydrate a "Lesson not found" verdict the client
// would then show without retrying.
type LessonLookup = { ok: true; lesson: Lesson | null } | { ok: false; error: unknown };

function lookUpLesson(env: Env, slug: string): Promise<LessonLookup> {
  return findPublishedLessonBySlug(env, slug).then(
    (lesson): LessonLookup => ({ ok: true, lesson }),
    (error: unknown): LessonLookup => ({ ok: false, error }),
  );
}

/**
 * GET /learn/:slug — data-only SSR for lesson detail. The page itself stays
 * client-rendered (the editor is Monaco + WebContainers), but resolving the
 * row here gives crawlers real per-lesson metadata instead of the generic
 * shell every lesson URL used to serve, and dehydrates that same row into the
 * React Query cache so the browser skips the /api/lessons/:slug round trip it
 * would otherwise make on a direct visit. In-app navigations never reach this
 * handler — the gallery and playlist views seed the same cache entry from the
 * list they already hold (tube/src/hooks/useLessons.ts).
 *
 * Any failure degrades to the untouched SPA shell: an un-decorated document
 * still works, an error page does not.
 */
export async function serveLessonDetailDocument(
  env: Env,
  request: Request,
  slug: string,
): Promise<Response> {
  // Author profiles share this path segment (see LearnSlugRoute) and aren't
  // lessons at all. Their shell is fetched by its canonical URL: Static Assets
  // percent-encodes every path segment it is asked for, so /learn/@chan would
  // come back as a 307 to /learn/%40chan, an extra round trip for the
  // browser before the same index.html.
  if (slug.startsWith("@")) {
    return serveAppShell(env.ASSETS, request);
  }

  // The shell and the row are independent, so the D1 lookup runs while the
  // shell is fetched instead of after it: the document waits for the slower
  // of the two, not their sum.
  const [assetResponse, lookup] = await Promise.all([
    env.ASSETS.fetch(request),
    lookUpLesson(env, slug),
  ]);

  if (!lookup.ok) {
    console.error("Lesson detail SSR failed", { slug }, lookup.error);
    return assetResponse;
  }

  try {
    if (!lookup.lesson) {
      return await renderMissingLessonResponse(assetResponse, slug);
    }

    const origin = env.PUBLIC_URL || new URL(request.url).origin;
    return await renderLessonDetailResponse(assetResponse, {
      lesson: lookup.lesson,
      slug,
      origin,
    });
  } catch (error) {
    console.error("Lesson detail SSR failed", { slug }, error);
    return assetResponse;
  }
}
