import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { Lesson } from "../types";
import { useLessonsInfinite } from "../hooks/useLessons";
import LessonCard from "./LessonCard";
import SearchBar from "./SearchBar";

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

function chunk(items: Lesson[], size: number): Lesson[][] {
  const cols = Math.max(1, size);
  const rows: Lesson[][] = [];
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
  const columns = useColumns();

  const lessons = data?.pages.flatMap((p) => p.lessons) ?? [];

  const q = query.trim().toLowerCase();
  const filtered = q
    ? lessons.filter(
        (l) =>
          l.title.toLowerCase().includes(q) ||
          l.description.toLowerCase().includes(q) ||
          l.tags?.some((t) => t.toLowerCase().includes(q)),
      )
    : lessons;
  const rows = chunk(filtered, columns);

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
  // while searching: filter what's loaded instead of paging in the background.
  const canPage = hasNextPage && !q;
  const sentinelRef = useRef<HTMLButtonElement>(null);
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

  if (isPending) {
    return <div className="flex justify-center py-20 text-slate-400">Loading lessons...</div>;
  }

  if (isError) {
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

  return (
    <div>
      {lessons.length > 0 && <SearchBar value={query} onChange={setQuery} />}

      {filtered.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">
          {lessons.length === 0 ? "No lessons yet." : "No lessons match your search."}
        </div>
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
                    {rows[vi.index].map((lesson) => (
                      <LessonCard key={lesson.slug} lesson={lesson} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {canPage && (
            // Outside the virtualizer so the keyboard escape hatch survives:
            // the observer drives the mouse path; on a load-more failure it
            // becomes Retry.
            <div className="flex justify-center py-10">
              <button
                ref={sentinelRef}
                type="button"
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950 disabled:cursor-default disabled:opacity-60"
              >
                {isFetchingNextPage ? "Loading…" : isFetchNextPageError ? "Retry" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
