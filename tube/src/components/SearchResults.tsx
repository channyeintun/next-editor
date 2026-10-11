import { Link } from "react-router";
import { avatarProxyUrl, type SearchResults as SearchResultsData } from "@next-editor/infra";
import { busyFadeClass, RESULTS_ENTER_CLASS } from "../lib/busyFade";
import LessonCard from "./LessonCard";

interface SearchResultsProps {
  /** The submitted search's answer, or the last one while a newer search loads. */
  data: SearchResultsData | undefined;
  isError: boolean;
  /** A newer search is loading and `data` is the previous answer. */
  isBusy: boolean;
  onRetry: () => void;
}

// Renders authors before lessons, per the product requirement that search
// surface matching authors first. Unlike the empty-query gallery, results
// here come from the backend (every published lesson/author, not just
// what's been paged into the client) so they're not virtualized — result
// counts are capped server-side (see infra/worker/routes/search.ts).
// LessonGrid owns the one search query and shows the gallery until the first
// answer, so there is no "Searching…" step here.
export default function SearchResults({ data, isError, isBusy, onRetry }: SearchResultsProps) {
  if (isError && !isBusy) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p role="alert" className="text-red-300">
          Search failed
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data) return null;

  const { authors, lessons } = data;

  // A newer search is loading: the last answer (results or "no match") stays,
  // dimmed and inert, until it lands.
  return (
    <div
      aria-busy={isBusy}
      inert={isBusy}
      className={`${busyFadeClass(isBusy)} ${RESULTS_ENTER_CLASS}`}
    >
      {authors.length === 0 && lessons.length === 0 && (
        <div className="flex justify-center py-20 text-slate-300">
          No authors or lessons match your search.
        </div>
      )}
      {authors.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-300">
            Authors
          </h2>
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
                {author.name || author.username}
              </Link>
            ))}
          </div>
        </div>
      )}

      {lessons.length > 0 && (
        <>
          {/* Without it the lesson card h3s read as children of "Authors". */}
          <h2 className="sr-only">Lessons</h2>
          <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {lessons.map((lesson) => (
              <LessonCard key={lesson.slug} lesson={lesson} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
