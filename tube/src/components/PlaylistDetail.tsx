import { ListMusic } from "lucide-react";
import type { Playlist } from "../types";
import Breadcrumb from "./Breadcrumb";
import LessonCard from "./LessonCard";

export default function PlaylistDetail({ playlist }: { playlist: Playlist }) {
  const count = playlist.lessons.length;

  return (
    <div className="py-4">
      <Breadcrumb title={playlist.title} />

      <div className="py-6">
        <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-slate-400">
          <ListMusic className="size-3.5" />
          Playlist · {count} {count === 1 ? "lesson" : "lessons"}
        </p>
        <h1 className="mt-1.5 text-2xl font-semibold text-white">{playlist.title}</h1>
        {playlist.description && (
          <p className="mt-2 max-w-2xl text-sm text-slate-400">{playlist.description}</p>
        )}
      </div>

      {playlist.lessons.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">No lessons yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-5 pb-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {playlist.lessons.map((lesson) => (
            <LessonCard key={lesson.slug} lesson={lesson} listSlug={playlist.slug} />
          ))}
        </div>
      )}
    </div>
  );
}
