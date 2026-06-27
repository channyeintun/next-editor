import { Link } from "react-router";
import type { Lesson } from "../types";
import { resolveThumb } from "../lib/links";

export default function LessonCard({ lesson }: { lesson: Lesson }) {
  const meta = [lesson.author, lesson.publishedAt].filter(Boolean).join(" · ");

  return (
    <Link to={`/learn/${lesson.slug}`} className="group block">
      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
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

      <div className="mt-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-white">
          {lesson.title}
        </h3>
        {meta && <p className="mt-1 text-xs text-slate-400">{meta}</p>}
      </div>
    </Link>
  );
}
