import GalleryShell from "./GalleryShell";
import LessonCardSkeleton from "./LessonCardSkeleton";

// Stand-in for LearnPage while its chunk downloads. Everything on that page —
// navbar actions, search bar, card grid — ships in the lazy tube chunk, so
// without this the gallery's only first paint is a centered spinner, and the
// route hands over to LessonGrid's own card skeletons only after the chunk
// lands. Draws LearnPage's GalleryShell and the LessonCardSkeleton LessonGrid
// uses, in LessonGrid's grid (grid-cols-1 sm:2 lg:3 xl:4, matching
// GALLERY_COLUMN_QUERIES), so the handover doesn't move anything.
//
// Eager-bundle-safe: GalleryShell brings only Navbar, which is already there
// (LandingPage renders it), and the card skeleton has no dependencies.

const PLACEHOLDER_CARDS = 8;

export default function LessonGallerySkeleton() {
  return (
    <GalleryShell loadingLabel="Loading lessons">
      <div className="h-10 w-full max-w-md animate-pulse rounded-full bg-slate-800" />

      <div className="grid grid-cols-1 gap-5 py-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: PLACEHOLDER_CARDS }).map((_, index) => (
          <LessonCardSkeleton key={index} />
        ))}
      </div>
    </GalleryShell>
  );
}
