import { useEffect, useRef, useState } from "react";
import { useSearch } from "@next-editor/infra";
import { useLessonsInfinite } from "../hooks/useLessons";
import { useWarmLessonRoute } from "../hooks/useWarmLessonRoute";
import { GALLERY_COLUMN_QUERIES } from "../lib/galleryColumns";
import { flattenLessonPages } from "../lib/lessons";
import { busyFadeClass } from "../lib/busyFade";
import { settleWithoutFirstRow, whenFirstRowThumbnailsSettled } from "../lib/firstRowThumbnails";
import type { Lesson } from "../types";
import LessonRows from "./LessonRows";
import LessonCardSkeleton from "@app/components/LessonCardSkeleton";
import SearchBar from "./SearchBar";
import SearchResults from "./SearchResults";
import LangText from "@app/components/LangText";

function readColumns(): number {
  if (typeof window === "undefined") return 1;
  return GALLERY_COLUMN_QUERIES.find((c) => window.matchMedia(c.query).matches)?.columns ?? 1;
}

function useColumns(): number {
  const [columns, setColumns] = useState(readColumns);
  useEffect(() => {
    const mqls = GALLERY_COLUMN_QUERIES.map((c) => window.matchMedia(c.query));
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
  // What the field holds, and what was last searched for: typing changes only
  // the first; Enter copies it into the second, which is what the page shows.
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  // The page's one search observer; SearchResults draws what it holds.
  const search = useSearch(submittedQuery);
  // Placeholder data is the last search that had an answer, not what is on
  // screen: it may stand in for a loading search only when results were
  // showing when Enter was pressed. After Escape the gallery was showing, so
  // the gallery stays (dimmed) until the new search answers.
  const [fromResults, setFromResults] = useState(false);
  const showResults =
    Boolean(submittedQuery) && !search.isPending && (!search.isPlaceholderData || fromResults);
  const isSearching = Boolean(submittedQuery) && (search.isPending || search.isPlaceholderData);
  // The query whose own answer is on screen. The results remount when it
  // changes, so a new answer comes in whole instead of moving kept cards around
  // (a layout shift); while a newer search loads it stays, keeping the dimmed
  // results mounted.
  const [answeredQuery, setAnsweredQuery] = useState("");
  if (search.data && !search.isPlaceholderData && submittedQuery !== answeredQuery) {
    setAnsweredQuery(submittedQuery);
  }
  const searchInputRef = useRef<HTMLInputElement>(null);
  // A retry replaces the failure with a loading search, so nothing older may
  // stand in for it, and focus goes back to the field the button leaves.
  const retrySearch = () => {
    setFromResults(false);
    if (!search.isFetching) void search.refetch();
  };
  const searchBar = (
    <SearchBar
      inputRef={searchInputRef}
      value={query}
      onChange={setQuery}
      onSubmit={() => {
        const next = query.trim();
        // Enter on the query that just failed tries it again; setting the same
        // value would change nothing.
        if (next && next === submittedQuery && search.isError) {
          retrySearch();
          return;
        }
        setFromResults(showResults && !search.isError);
        setSubmittedQuery(next);
      }}
      onClear={() => {
        setFromResults(false);
        setQuery("");
        setSubmittedQuery("");
      }}
      isDirty={query.trim() !== submittedQuery}
    />
  );
  const columns = useColumns();

  const lessons = flattenLessonPages(data?.pages);
  // The first row's thumbnails are what the page waits for (its LCP); when the
  // gallery has no such row to show, there is nothing to wait for.
  const waitsForFirstRow = !showResults && (isPending || lessons.length > 0);
  useEffect(() => {
    if (!waitsForFirstRow) settleWithoutFirstRow();
  }, [waitsForFirstRow]);
  const skeletonsToAppend = isFetchingNextPage
    ? (columns - (lessons.length % columns)) % columns || columns
    : 0;
  const items: (Lesson | null)[] = [...lessons, ...Array<null>(skeletonsToAppend).fill(null)];
  const rows = chunk(items, columns);

  // A card click opens the lesson route, which the gallery deliberately does
  // not load up front; fetch it once the first row has its thumbnails.
  useWarmLessonRoute(whenFirstRowThumbnailsSettled());

  // Auto-load the next page when the sentinel nears the viewport. Suppressed
  // while searching: the query bar switches to backend search results
  // instead (see the render below), so there's no infinite list to page.
  const canPage = hasNextPage && !showResults;
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

  // One status region shared by every branch below, always the root's first
  // child, so React keeps the same live node across branch switches and screen
  // readers announce its text changes (a region mounted together with its text
  // is not reliably read). Errors are announced by their own role="alert".
  let statusText = "";
  if (submittedQuery) {
    if (isSearching || (search.isError && search.isFetching)) statusText = "Searching…";
    else if (search.data && !search.isError) {
      const authorCount = search.data.authors.length;
      const lessonCount = search.data.lessons.length;
      const counts =
        authorCount + lessonCount === 0
          ? "No authors or lessons match your search."
          : `${lessonCount} ${lessonCount === 1 ? "lesson" : "lessons"} and ${authorCount} ${authorCount === 1 ? "author" : "authors"} found`;
      // Naming the query makes each search's text new, so it is announced even
      // when two searches find the same counts.
      statusText = `Results for “${submittedQuery}”: ${counts}`;
    }
  } else if (isPending) statusText = "Loading lessons…";
  else if (isFetchingNextPage) statusText = "Loading more lessons…";
  const status = (
    <p role="status" className="sr-only">
      <LangText text={statusText} />
    </p>
  );

  // `useInfiniteQuery` flips `status` to "error" for ANY failed fetch, including a
  // `fetchNextPage()` that fails with earlier pages already rendered. Gating the
  // whole component on bare `isError` therefore threw away every loaded card, the
  // scroll position and the search bar over one paging blip. Full-page error is
  // for "we have nothing to show" (page 0 itself failed); a paging failure gets
  // the inline retry row below the grid instead. A search runs its own query, so
  // a failed gallery page 0 never replaces search results. The field keeps its
  // child slot (after the status) in every branch, so a query being typed, or a
  // search still loading, keeps its field and focus.
  if (isError && lessons.length === 0 && !showResults) {
    return (
      <div>
        {status}
        {(query || submittedQuery) && searchBar}
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p role="alert" className="text-red-300">
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
      </div>
    );
  }

  // Page 0 is a network fetch, so a search can start before it lands (or after
  // it fails). The box stays either way: it is what the search is typed into.
  if (showResults) {
    return (
      <div>
        {status}
        {searchBar}
        <SearchResults
          key={answeredQuery}
          data={search.data}
          isError={search.isError}
          isBusy={search.isPlaceholderData}
          onRetry={() => {
            retrySearch();
            searchInputRef.current?.focus();
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {status}
      {(lessons.length > 0 || isPending || submittedQuery) && searchBar}

      {/* Inert while dimmed: what is about to be replaced is not to be reached. */}
      <div aria-busy={isSearching} inert={isSearching} className={busyFadeClass(isSearching)}>
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
          <div className="flex justify-center py-20 text-slate-300">No lessons yet.</div>
        ) : (
          <>
            <LessonRows rows={rows} columns={columns} />

            {isFetchNextPageError ? (
              <div className="flex flex-col items-center gap-3 pb-10 pt-5 text-center">
                <p role="alert" className="text-sm text-red-300">
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
    </div>
  );
}
