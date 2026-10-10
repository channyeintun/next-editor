import { Link } from "react-router";
import { Play } from "lucide-react";
import LangText from "@app/components/LangText";
import type { Lesson } from "../types";
import { resolveThumb } from "../lib/links";
import ThumbnailTile from "./ThumbnailTile";

// "2026-06-28" → "Jun 28, 2026". Parsed as a local date (not UTC) to avoid an
// off-by-one day in timezones behind UTC. Non-date strings pass through as-is.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatPublished(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return value;
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export default function LessonCard({
  lesson,
  listSlug,
  priority = false,
}: {
  lesson: Lesson;
  /** Slug of the playlist this card is rendered within — appended as `?list=` so the
   *  lesson page can offer "Continue to Next" through the same playlist. */
  listSlug?: string;
  /** In the first row on screen: its thumbnail is the page's LCP candidate, so it
   *  loads at once and at high priority instead of lazily. */
  priority?: boolean;
}) {
  const href = listSlug ? `/learn/${lesson.slug}?list=${listSlug}` : `/learn/${lesson.slug}`;
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
        <ThumbnailTile
          src={resolveThumb(lesson.thumbnail)}
          alt={lesson.title}
          fallbackIcon={Play}
          priority={priority}
          hoverScale
        />
        {lesson.duration && (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/80 px-1.5 py-0.5 text-xs font-semibold text-white">
            {lesson.duration}
          </span>
        )}
      </Link>

      <div className="mt-3">
        {/* The two-line clamp (overflow: hidden) sits on the link, not the h3:
            an element's own focus ring is not clipped by its own overflow, but
            it is by an ancestor's, which left only slivers of the ring. */}
        <h3 className="text-sm font-semibold leading-snug">
          <Link
            to={href}
            className="line-clamp-2 rounded text-white outline-none focus-visible:ring-2 focus-visible:ring-pinata-purple focus-visible:ring-offset-2 focus-visible:ring-offset-[#11141c]"
          >
            <LangText text={lesson.title} />
          </Link>
          {/* The visible duration badge sits inside the aria-hidden thumbnail
              link, so screen readers get it here, after the link: heading and
              browse navigation read "title, duration 4:12" while the link's
              name stays exactly its visible title. */}
          {lesson.duration && <span className="sr-only">, duration {lesson.duration}</span>}
        </h3>
        {(lesson.author || published) && (
          // slate-300 on the #11141c page is 12.4:1 (WCAG AAA); slate-400 renders
          // as #90a1b9, 6.9997:1, just under the 7:1 AAA floor.
          <p className="mt-1 text-xs text-slate-300">
            {lesson.author &&
              (lesson.authorUrl ? (
                <Link
                  to={lesson.authorUrl}
                  className="rounded outline-none hover:text-white hover:underline focus-visible:text-white focus-visible:underline"
                >
                  {lesson.author}
                </Link>
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
