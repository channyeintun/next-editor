import type { Playlist } from "../types";
import Breadcrumb from "./Breadcrumb";
import LessonCard from "./LessonCard";

export default function PlaylistDetail({ playlist }: { playlist: Playlist }) {
  return (
    <div className="py-4">
      <Breadcrumb title={playlist.title} />

      <div className="py-6">
        <h1 className="text-2xl font-semibold text-white">{playlist.title}</h1>
        {playlist.description && (
          <p className="mt-2 max-w-2xl text-sm text-slate-400">{playlist.description}</p>
        )}
      </div>

      {playlist.lessons.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">No lessons yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {playlist.lessons.map((lesson) => (
            <LessonCard key={lesson.slug} lesson={lesson} />
          ))}
        </div>
      )}
    </div>
  );
}
