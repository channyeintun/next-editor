import Breadcrumb from "./Breadcrumb";
import EditorShellSkeleton from "./EditorShellSkeleton";
import { lessonTitleFromSlug } from "../utils/lessonSlug";
import { useEmbedded } from "../utils/embed";

/**
 * A lesson page before its lesson is in hand. Every gate on the way to a
 * playable lesson (the route's chunk, the detail view's chunk, the lesson
 * lookup) paints this same frame, so the page assembles in place instead of
 * flashing between screens. The slug is already in the URL, so the breadcrumb
 * can name the lesson before anything has been fetched; an embedded lesson has
 * no breadcrumb.
 *
 * Eager-bundle-safe, like EditorShellSkeleton: the router's HydrateFallback
 * renders it.
 */
export default function LessonPageSkeleton({ slug }: { slug: string | undefined }) {
  const embedded = useEmbedded();
  const placeholderTitle = embedded ? undefined : lessonTitleFromSlug(slug);

  return (
    <EditorShellSkeleton
      breadcrumb={placeholderTitle ? <Breadcrumb title={placeholderTitle} /> : undefined}
      showPlayerBar
    />
  );
}
