import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { useSearch } from "@next-editor/infra";
import { useLessonsInfinite } from "../hooks/useLessons";
import { useWarmLessonRoute } from "../hooks/useWarmLessonRoute";
import { GALLERY_COLUMN_QUERIES } from "../lib/galleryColumns";
import { flattenGalleryPages } from "../lib/lessons";
import { busyFadeClass } from "../lib/busyFade";
import { settleWithoutFirstRow, whenFirstRowThumbnailsSettled } from "../lib/firstRowThumbnails";
import { searchQueryFrom, withSearchQuery } from "../lib/searchQuery";
import type { GalleryItem } from "../types";
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

/** "1 lesson", "3 lessons". */
function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  // What was last searched for is the URL's (/learn?q=…), so Back from a
  // result, a reload and a shared link bring the search back. The field holds
  // what is being typed: typing changes only the field; Enter puts it in the
  // URL as a new history entry, which is what the page shows.
  const [searchParams, setSearchParams] = useSearchParams();
  const submittedQuery = searchQueryFrom(searchParams);
  const [query, setQuery] = useState(submittedQuery);
  const showSearch = (next: string) => setSearchParams((params) => withSearchQuery(params, next));
  // The page's one search observer; SearchResults draws what it holds.
  const search = useSearch(submittedQuery);
  // An infinite query is in error when only a later page failed too; that
  // failure belongs to "Show more lessons", with the results kept on screen.
  const searchFailed = search.isError && !search.isFetchNextPageError;
  // Placeholder data is the last search that had an answer, not what is on
  // screen: it may stand in for a loading search only when results were
  // showing when the search changed. After Escape the gallery was showing, so
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
  // The search changed — by Enter, by Clear, or by Back/Forward through the
  // history. The field shows it, and the last answer may stand in while it
  // loads only if that answer was what the page showed.
  const [shownQuery, setShownQuery] = useState(submittedQuery);
  if (submittedQuery !== shownQuery) {
    setShownQuery(submittedQuery);
    setQuery(submittedQuery);
    setFromResults(Boolean(shownQuery) && answeredQuery === shownQuery);
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
        // Enter on the search already showing adds no history entry; on one
        // that just failed, it tries it again.
        if (next === submittedQuery) {
          if (next && searchFailed) retrySearch();
          return;
        }
        showSearch(next);
      }}
      onClear={() => {
        setQuery("");
        if (submittedQuery) showSearch("");
      }}
      isDirty={query.trim() !== submittedQuery}
    />
  );
  const columns = useColumns();

  // The gallery's cards: a playlist in place of the lessons it holds, and each
  // lesson in no playlist on its own.
  const cards = flattenGalleryPages(data?.pages);
  // The first row's thumbnails are what the page waits for (its LCP); when the
  // gallery has no such row to show, there is nothing to wait for.
  const waitsForFirstRow = !showResults && (isPending || cards.length > 0);
  useEffect(() => {
    if (!waitsForFirstRow) settleWithoutFirstRow();
  }, [waitsForFirstRow]);
  const skeletonsToAppend = isFetchingNextPage
    ? (columns - (cards.length % columns)) % columns || columns
    : 0;
  const items: (GalleryItem | null)[] = [...cards, ...Array<null>(skeletonsToAppend).fill(null)];
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
    if (isSearching || (searchFailed && search.isFetching)) statusText = "Searching…";
    else if (search.isFetchingNextPage) statusText = "Loading more lessons…";
    else if (search.data && !searchFailed) {
      const { authors, playlists, lessons, lessonTotal, pageCount } = search.data;
      // Naming the query makes each search's text new, so it is announced even
      // when two searches find the same counts. After Show more lessons, the
      // text says how far the reader has got.
      statusText =
        pageCount > 1
          ? `Showing ${lessons.length} of ${countOf(lessonTotal, "lesson")} for “${submittedQuery}”`
          : `Results for “${submittedQuery}”: ${
              lessonTotal + playlists.length + authors.length === 0
                ? "No authors, playlists or lessons match your search."
                : `${countOf(lessonTotal, "lesson")}, ${countOf(playlists.length, "playlist")} and ${countOf(authors.length, "author")} found`
            }`;
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
  if (isError && cards.length === 0 && !showResults) {
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
          isError={searchFailed}
          isBusy={search.isPlaceholderData}
          onRetry={() => {
            retrySearch();
            searchInputRef.current?.focus();
          }}
          more={{
            hasMore: search.hasNextPage,
            isLoading: search.isFetchingNextPage,
            isError: search.isFetchNextPageError,
            load: () => {
              if (!search.isFetching) void search.fetchNextPage();
            },
          }}
        />
      </div>
    );
  }

  return (
    <div>
      {status}
      {(cards.length > 0 || isPending || submittedQuery) && searchBar}

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
        ) : cards.length === 0 ? (
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
