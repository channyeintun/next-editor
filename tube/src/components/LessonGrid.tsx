import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useLessonsInfinite } from "../hooks/useLessons";
import { flattenLessonPages } from "../lib/lessons";
import LessonCard from "./LessonCard";
import LessonCardSkeleton from "./LessonCardSkeleton";
import SearchBar from "./SearchBar";
import SearchResults from "./SearchResults";

// How long to wait after the last keystroke before firing the backend search
// request — avoids a request per keystroke while still feeling responsive.
const SEARCH_DEBOUNCE_MS = 300;

// Card columns per breakpoint — mirrors the Tailwind grid the cards used to live
// in (grid-cols-1 sm:2 lg:3 xl:4) so the virtualized layout looks identical.
const COLUMN_QUERIES = [
  { query: "(min-width: 1280px)", columns: 4 },
  { query: "(min-width: 1024px)", columns: 3 },
  { query: "(min-width: 640px)", columns: 2 },
];

function readColumns(): number {
  if (typeof window === "undefined") return 1;
  return COLUMN_QUERIES.find((c) => window.matchMedia(c.query).matches)?.columns ?? 1;
}

function useColumns(): number {
  const [columns, setColumns] = useState(readColumns);
  useEffect(() => {
    const mqls = COLUMN_QUERIES.map((c) => window.matchMedia(c.query));
    const update = () => setColumns(readColumns());
    mqls.forEach((m) => m.addEventListener("change", update));
    return () => mqls.forEach((m) => m.removeEventListener("change", update));
  }, []);
  return columns;
}

function chunk<T>(items: T[], size: number): T[][] {
  const cols = Math.max(1, size);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows;
}

export default function LessonGrid() {
  const {
    data,
    error,
    isPending,
    isError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = useLessonsInfinite();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);
  const columns = useColumns();

  const lessons = flattenLessonPages(data?.pages);
  const skeletonsToAppend = isFetchingNextPage
    ? (columns - (lessons.length % columns)) % columns || columns
    : 0;
  const items = [...lessons, ...Array(skeletonsToAppend).fill(null)];
  const rows = chunk(items, columns);

  // Virtualize rows against the page scroll, so the navbar and footer stay in
  // normal flow (no nested scrollbar) and only on-screen cards are mounted.
  // scrollMargin offsets the virtual list by its distance from the document top.
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const update = () => setScrollMargin(listRef.current?.offsetTop ?? 0);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => 320,
    overscan: 3,
    scrollMargin,
  });

  // Auto-load the next page when the sentinel nears the viewport. Suppressed
  // while searching: the query bar switches to backend search results
  // instead (see the render below), so there's no infinite list to page.
  const canPage = hasNextPage && !debouncedQuery;
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canPage || isFetchNextPageError) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) fetchNextPage();
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  // `useInfiniteQuery` flips `status` to "error" for ANY failed fetch, including a
  // `fetchNextPage()` that fails with earlier pages already rendered. Gating the
  // whole component on bare `isError` therefore threw away every loaded card, the
  // scroll position and the search bar over one paging blip — and since page 0 is
  // served from the bundled seed and cannot reject, that was the *only* way this
  // branch was ever reached. Full-page error is for "we have nothing to show"; a
  // paging failure gets the inline retry row below the grid instead.
  if (isError && lessons.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="text-red-400">
          {error instanceof Error ? error.message : "Failed to load lessons"}
        </p>
        <button
          type="button"
          onClick={() => refetch()}
          className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
        >
          Try again
        </button>
      </div>
    );
  }

  if (debouncedQuery) {
    return (
      <div>
        {lessons.length > 0 && <SearchBar value={query} onChange={setQuery} />}
        <SearchResults query={debouncedQuery} />
      </div>
    );
  }

  return (
    <div>
      {(lessons.length > 0 || isPending) && <SearchBar value={query} onChange={setQuery} />}

      {isPending ? (
        <div
          className="grid gap-5 py-5"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, i) => (
            <LessonCardSkeleton key={i} />
          ))}
        </div>
      ) : lessons.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">No lessons yet.</div>
      ) : (
        <>
          <div ref={listRef}>
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${vi.start - scrollMargin}px)` }}
                >
                  <div
                    className="grid gap-5 pb-5"
                    style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                  >
                    {rows[vi.index].map((lesson, idx) =>
                      lesson ? (
                        <LessonCard key={lesson.slug} lesson={lesson} />
                      ) : (
                        <LessonCardSkeleton key={`skel-${idx}`} />
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {isFetchNextPageError ? (
            <div className="flex flex-col items-center gap-3 pb-10 pt-5 text-center">
              <p className="text-sm text-red-400">
                {error instanceof Error ? error.message : "Failed to load more lessons"}
              </p>
              <button
                type="button"
                onClick={() => fetchNextPage()}
                className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
              >
                Load more
              </button>
            </div>
          ) : (
            canPage && <div ref={sentinelRef} className="pb-10 pt-5" />
          )}
        </>
      )}
    </div>
  );
}
