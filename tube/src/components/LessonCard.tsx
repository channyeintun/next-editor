import { useState } from "react";
import { Link } from "react-router";
import { Play } from "lucide-react";
import type { Lesson } from "../types";
import { resolveThumb } from "../lib/links";

// "2026-06-28" → "Jun 28, 2026". Parsed as a local date (not UTC) to avoid an
// off-by-one day in timezones behind UTC. Non-date strings pass through as-is.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatPublished(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export default function LessonCard({ lesson }: { lesson: Lesson }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const meta = [lesson.author, formatPublished(lesson.publishedAt)].filter(Boolean).join(" · ");

  return (
    <Link
      to={`/learn/${lesson.slug}`}
      className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
        {thumbFailed ? (
          <div className="flex size-full items-center justify-center bg-slate-800 text-slate-600">
            <Play className="size-8" />
          </div>
        ) : (
          <img
            src={resolveThumb(lesson)}
            alt={lesson.title}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105 group-focus-visible:scale-105"
          />
        )}
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
