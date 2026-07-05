import { Link } from "react-router";
import { avatarProxyUrl, useSearch } from "@next-editor/infra";
import LessonCard from "./LessonCard";

// Renders authors before lessons, per the product requirement that search
// surface matching authors first. Unlike the empty-query gallery, results
// here come from the backend (every published lesson/author, not just
// what's been paged into the client) so they're not virtualized — result
// counts are capped server-side (see infra/worker/routes/search.ts).
export default function SearchResults({ query }: { query: string }) {
  const { data, isPending, isError, refetch } = useSearch(query);

  if (isPending) {
    return <div className="flex justify-center py-20 text-slate-400">Searching…</div>;
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="text-red-400">Search failed</p>
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

  const { authors, lessons } = data;

  if (authors.length === 0 && lessons.length === 0) {
    return (
      <div className="flex justify-center py-20 text-slate-400">
        No authors or lessons match your search.
      </div>
    );
  }

  return (
    <div>
      {authors.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-400">
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
                  <span className="flex size-7 items-center justify-center rounded-full bg-pinata-purple text-xs font-semibold uppercase">
                    {(author.name ?? author.username)[0]}
                  </span>
                )}
                {author.name ?? author.username}
              </Link>
            ))}
          </div>
        </div>
      )}

      {lessons.length > 0 && (
        <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {lessons.map((lesson) => (
            <LessonCard key={lesson.slug} lesson={lesson} />
          ))}
        </div>
      )}
    </div>
  );
}
