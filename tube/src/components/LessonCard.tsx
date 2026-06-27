import { Clock, User } from "lucide-react";
import type { Lesson } from "../types";
import { buildPlayUrl, resolveThumb } from "../lib/links";

export default function LessonCard({ lesson }: { lesson: Lesson }) {
  const playUrl = buildPlayUrl(lesson);

  return (
    <a
      href={playUrl}
      className="group block overflow-hidden rounded-xl bg-white/5 transition-all hover:bg-white/10 hover:shadow-lg hover:shadow-black/20"
    >
      <div className="relative aspect-video overflow-hidden bg-slate-800">
        <img
          src={resolveThumb(lesson)}
          alt={lesson.title}
          loading="lazy"
          className="object-cover transition-transform duration-300 group-hover:scale-105 size-full"
        />
        {lesson.duration && (
          <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white">
            {lesson.duration}
          </span>
        )}
      </div>

      <div className="p-3">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug text-white">{lesson.title}</h3>
        <p className="mt-1 line-clamp-2 text-xs text-slate-400">{lesson.description}</p>
        <div className="mt-2 flex items-center gap-3 text-xs text-slate-500">
          {lesson.author && (
            <span className="flex items-center gap-1">
              <User className="size-3" />
              {lesson.author}
            </span>
          )}
          {lesson.publishedAt && (
            <span className="flex items-center gap-1">
              <Clock className="size-3" />
              {lesson.publishedAt}
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
