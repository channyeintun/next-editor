import { Link } from "react-router";
import { useMyLessons, useMyPlaylists } from "@next-editor/infra";
import MyLessonCard from "./MyLessonCard";
import LessonCardSkeleton from "./LessonCardSkeleton";
import PlaylistsSection from "./PlaylistsSection";

export default function MyLibraryGrid() {
  const { data, isPending, isError, refetch } = useMyLessons();
  // Independent of the lessons query's pending/error state below: playlists
  // render as soon as they're ready regardless of whether the lessons grid
  // is still loading, same as any other independent section on this page.
  const { data: playlists, isError: playlistsError, refetch: refetchPlaylists } = useMyPlaylists();

  if (isPending) {
    return (
      <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        <LessonCardSkeleton />
        <LessonCardSkeleton />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="text-red-400">Failed to load your lessons</p>
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
      {playlistsError ? (
        <div className="mb-8 flex flex-col items-center gap-3 border-b border-white/10 py-8 text-center">
          <p className="text-sm text-red-400">Failed to load your playlists</p>
          <button
            type="button"
            onClick={() => refetchPlaylists()}
            className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
          >
            Try again
          </button>
        </div>
      ) : (
        playlists && <PlaylistsSection playlists={playlists} lessons={data} />
      )}

      {data.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center text-slate-400">
          <p>You haven’t uploaded any lessons yet.</p>
          <Link
            to="/code"
            className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
          >
            Start creating
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data.map((lesson) => (
            <MyLessonCard key={lesson.id} lesson={lesson} />
          ))}
        </div>
      )}
    </div>
  );
}
