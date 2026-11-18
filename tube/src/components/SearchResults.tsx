import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { LoaderCircle } from "lucide-react";
import LangText from "@app/components/LangText";
import { avatarProxyUrl, type SearchResults as SearchResultsData } from "@next-editor/infra";
import { busyFadeClass, RESULTS_ENTER_CLASS } from "../lib/busyFade";
import LessonCard from "./LessonCard";
import PlaylistSummaryCard from "./PlaylistSummaryCard";

/** The next page of matching lessons, behind "Show more lessons". */
export interface MoreLessons {
  /** More lessons match than are shown. */
  hasMore: boolean;
  isLoading: boolean;
  /** Loading the last page asked for failed; the lessons shown stay. */
  isError: boolean;
  load: () => void;
}

interface SearchResultsProps {
  /** The submitted search's answer, or the last one while a newer search loads. */
  data: SearchResultsData | undefined;
  isError: boolean;
  /** A newer search is loading and `data` is the previous answer. */
  isBusy: boolean;
  onRetry: () => void;
  more: MoreLessons;
}

const sectionHeading = "mb-3 text-xs font-bold uppercase tracking-wider text-slate-300";
const pillButton =
  "rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950";

// Renders authors, then playlists, before lessons, per the product requirement
// that search surface matching authors first — and so searching for a course
// offers the course itself, in its own order, ahead of its lessons. Unlike the
// empty-query gallery, results here come from the backend (every published
// lesson/author, not just what's been paged into the client) so they're not
// virtualized; lessons come a page at a time, behind "Show more lessons" (see
// infra/worker/routes/search.ts). LessonGrid owns the one search query and
// shows the gallery until the first answer, so there is no "Searching…" step here.
export default function SearchResults({
  data,
  isError,
  isBusy,
  onRetry,
  more,
}: SearchResultsProps) {
  const lessonGridRef = useRef<HTMLDivElement>(null);
  // Set by Show more lessons to the index of the first lesson it will add.
  // When they arrive, focus moves to that lesson: the reader goes on from
  // there, instead of being left on the button below everything it added.
  const focusFromRef = useRef<number | null>(null);
  const lessonCount = data?.lessons.length ?? 0;
  useEffect(() => {
    const from = focusFromRef.current;
    if (from === null || lessonCount <= from) return;
    focusFromRef.current = null;
    lessonGridRef.current?.children[from]
      ?.querySelector<HTMLElement>('a[href]:not([tabindex="-1"])')
      ?.focus();
  }, [lessonCount]);

  if (isError && !isBusy) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p role="alert" className="text-red-300">
          Search failed
        </p>
        <button type="button" onClick={onRetry} className={pillButton}>
          Try again
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { authors, playlists, lessons, lessonTotal } = data;

  // A newer search is loading: the last answer (results or "no match") stays,
  // dimmed and inert, until it lands.
  return (
    <div
      aria-busy={isBusy}
      inert={isBusy}
      className={`${busyFadeClass(isBusy)} ${RESULTS_ENTER_CLASS}`}
    >
      {authors.length === 0 && playlists.length === 0 && lessons.length === 0 && (
        <div className="flex justify-center py-20 text-slate-300">
          No authors, playlists or lessons match your search.
        </div>
      )}
      {authors.length > 0 && (
        <section className="mb-8">
          <h2 className={sectionHeading}>Authors</h2>
          <div className="flex flex-wrap gap-3">
            {authors.map((author) => (
              <Link
                key={author.username}
                to={`/learn/@${author.username}`}
                className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pl-1.5 pr-4 text-sm text-white transition-colors hover:bg-white/10"
              >
                {author.avatarUrl ? (
                  <img
                    src={avatarProxyUrl(author.avatarUrl)}
                    alt=""
                    className="size-7 rounded-full"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="flex size-7 items-center justify-center rounded-full bg-pinata-purple text-xs font-semibold uppercase"
                  >
                    {(author.name || author.username)[0]}
                  </span>
                )}
                <LangText text={author.name || author.username} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section className="mb-8">
          <h2 className={sectionHeading}>Playlists</h2>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {playlists.map((playlist) => (
              <PlaylistSummaryCard key={playlist.slug} playlist={playlist} />
            ))}
          </div>
        </section>
      )}

      {lessons.length > 0 && (
        <section>
          {/* Visible once other sections share the page; otherwise only for
              heading navigation, so the lesson card h3s never read as
              children of "Authors". */}
          <h2 className={authors.length > 0 || playlists.length > 0 ? sectionHeading : "sr-only"}>
            Lessons
          </h2>
          <div
            ref={lessonGridRef}
            className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {lessons.map((lesson) => (
              <LessonCard key={lesson.slug} lesson={lesson} />
            ))}
          </div>

          {more.hasMore && (
            <div className="flex flex-col items-center gap-3 pb-10 pt-5 text-center">
              <p className="text-xs text-slate-300">
                Showing {lessons.length} of {lessonTotal} lessons
              </p>
              {more.isError && !more.isLoading && (
                <p role="alert" className="text-sm text-red-300">
                  Couldn't load more lessons. Try again.
                </p>
              )}
              {/* aria-disabled, not disabled, while loading: a disabled button
                  drops the focus it holds to the page. The status region in
                  LessonGrid says that more lessons are loading. */}
              <button
                type="button"
                aria-disabled={more.isLoading || undefined}
                onClick={() => {
                  if (more.isLoading) return;
                  focusFromRef.current = lessons.length;
                  more.load();
                }}
                className={`inline-flex items-center gap-2 ${pillButton} aria-disabled:cursor-default aria-disabled:opacity-70`}
              >
                {more.isLoading && (
                  <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                )}
                Show more lessons
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
