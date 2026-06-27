import { Clock, User } from "lucide-react";
import { Link } from "react-router";
import type { Lesson } from "../types";
import { resolveThumb } from "../lib/links";

export default function LessonCard({ lesson }: { lesson: Lesson }) {
  return (
    <Link
      to={`/learn/${lesson.slug}`}
      className="group block overflow-hidden rounded-2xl border border-white/10 bg-white/5 transition-all hover:-translate-y-0.5 hover:border-white/20 hover:bg-white/[0.07] hover:shadow-2xl hover:shadow-black/30"
    >
      <div className="relative aspect-video overflow-hidden bg-slate-900">
        <img
          src={resolveThumb(lesson)}
          alt={lesson.title}
          loading="lazy"
          className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
        />
        {lesson.duration && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
            {lesson.duration}
          </span>
        )}
      </div>

      <div className="p-4">
        <h3 className="line-clamp-2 font-machina text-sm uppercase leading-snug tracking-tight text-white">
          {lesson.title}
        </h3>
        <p className="mt-1.5 line-clamp-2 text-sm text-slate-400">{lesson.description}</p>

        {lesson.tags && lesson.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {lesson.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-slate-300"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center gap-3 text-xs text-slate-500">
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
    </Link>
  );
}
