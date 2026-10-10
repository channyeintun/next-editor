// The /learn/:slug route's code, reached only through these dynamic imports.
// LearnSlugRoute renders a lesson (LessonDetailRoute, and behind it the lesson
// player: Editor, collaboration, the recording codec, about 220 KB) or an
// author profile, each behind React.lazy. The gallery and playlist pages never
// render either, and importing one statically would make their thumbnails wait
// for it again (src/monacoStaticImports.test.ts guards that), so they warm the
// lesson view from here once their own content is in.

/**
 * Whether a /learn/:slug URL names an author profile (/learn/@handle) rather
 * than a lesson. Lesson slugs (slugifyTitle() in infra/db/slug.ts) never start
 * with "@".
 */
export function isAuthorProfileSlug(slug: string | undefined): slug is `@${string}` {
  return slug?.startsWith("@") ?? false;
}

export function loadLearnSlugRoute() {
  return import("./components/LearnSlugRoute");
}

export function loadLessonDetailRoute() {
  return import("./components/LessonDetailRoute");
}

export function loadAuthorProfilePage() {
  return import("./AuthorProfilePage");
}

/**
 * Starts the chunk of the view a /learn/:slug URL renders, so it downloads
 * alongside LearnSlugRoute's rather than once that has rendered. Failures are
 * left to LearnSlugRoute's lazy imports, which report them.
 */
export function prefetchLearnSlugView(slug: string | undefined): void {
  (isAuthorProfileSlug(slug) ? loadAuthorProfilePage() : loadLessonDetailRoute()).catch(() => {});
}

/**
 * Fetches the lesson page ahead of a card click, so the click opens it at
 * once. Failures are swallowed: a real navigation imports it again and reports
 * its own failure, and a warm-up must never trip the stale-chunk reload.
 */
export function warmLessonRoute(): void {
  loadLearnSlugRoute().catch(() => {});
  loadLessonDetailRoute().catch(() => {});
}
