import Navbar from "./Navbar";

// Stand-in for LearnPage while its chunk downloads. Everything on that page —
// navbar actions, search bar, card grid — ships in the lazy tube chunk, so
// without this the gallery's only first paint is a centered spinner, and the
// route hands over to LessonGrid's own card skeletons only after the chunk
// lands. Mirrors LearnPage's shell and LessonGrid's grid (grid-cols-1 sm:2
// lg:3 xl:4, matching COLUMN_QUERIES) so the handover doesn't move anything.
//
// Eager-bundle-safe: Navbar is already there (LandingPage renders it) and
// nothing else here has dependencies.

const PLACEHOLDER_CARDS = 8;

export default function LessonGallerySkeleton() {
  return (
    <div
      aria-label="Loading lessons"
      className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white"
      role="status"
    >
      <Navbar minimal />

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8" aria-hidden="true">
        <div className="h-10 w-full max-w-md animate-pulse rounded-full bg-slate-800" />

        <div className="grid grid-cols-1 gap-5 py-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: PLACEHOLDER_CARDS }).map((_, index) => (
            // Same shape as tube's LessonCardSkeleton, which takes over from here.
            <div className="animate-pulse" key={index}>
              <div className="aspect-video w-full rounded-xl bg-slate-800" />
              <div className="mt-3 space-y-2">
                <div className="h-4 w-3/4 rounded bg-slate-800" />
                <div className="h-3 w-1/2 rounded bg-slate-800" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
