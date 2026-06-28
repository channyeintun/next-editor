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
  const href = `/learn/${lesson.slug}`;
  const published = formatPublished(lesson.publishedAt);

  return (
    // Not a single Link: the thumbnail + title go to the lesson, while the
    // author name is its own link to the profile (an <a> nested inside a <Link>
    // is invalid). The thumbnail link is removed from the tab order so keyboard
    // users get one stop for the lesson (the title) and one for the author.
    <div className="group">
      <Link
        to={href}
        tabIndex={-1}
        aria-hidden="true"
        className="relative block aspect-video overflow-hidden rounded-xl bg-slate-900"
      >
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
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        )}
        {lesson.duration && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
            {lesson.duration}
          </span>
        )}
      </Link>

      <div className="mt-3">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
          <Link
            to={href}
            className="rounded text-white outline-none focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
          >
            {lesson.title}
          </Link>
        </h3>
        {(lesson.author || published) && (
          <p className="mt-1 text-xs text-slate-400">
            {lesson.author &&
              (lesson.authorUrl ? (
                <a
                  href={lesson.authorUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded outline-none hover:text-white hover:underline focus-visible:text-white focus-visible:underline"
                >
                  {lesson.author}
                </a>
              ) : (
                <span>{lesson.author}</span>
              ))}
            {lesson.author && published && " · "}
            {published && <span>{published}</span>}
          </p>
        )}
      </div>
    </div>
  );
}
