import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Play } from "lucide-react";
import LangText from "@app/components/LangText";
import type { Playlist } from "../types";
import { lessonHref } from "../lib/links";

/**
 * The playlist's lessons, in order, inside the lesson page's playlist crumb
 * (BreadcrumbMenu): where this lesson sits, and a link to every other one.
 * Built from the playlist the page already loaded for `?list=`, so it costs
 * no request of its own.
 */
export default function PlaylistLessonsMenu({
  playlist,
  currentSlug,
}: {
  playlist: Playlist;
  currentSlug: string;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const position = playlist.lessons.findIndex((lesson) => lesson.slug === currentSlug) + 1;

  // Opened mid-course, the list starts with the lesson playing in its middle,
  // so the lessons before and after it are both in view.
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement;
    if (!list || !current) return;
    list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2;
  }, []);

  return (
    <>
      <div className="border-b border-slate-700 px-3 py-2">
        <p className="truncate font-semibold text-white">
          <LangText text={playlist.title} />
        </p>
        {position > 0 && (
          <p className="text-xs text-slate-300">
            Lesson {position} of {playlist.lessons.length}
          </p>
        )}
      </div>
      {/* `relative`, so each item's offsetTop is measured from the list. */}
      <ol ref={listRef} className="relative max-h-[min(60vh,24rem)] overflow-y-auto py-1">
        {playlist.lessons.map((lesson, index) => {
          const current = lesson.slug === currentSlug;
          return (
            <li key={lesson.slug}>
              {/* The lesson playing: a bar at its edge and a play mark in place
                  of its number (not the tint alone), and aria-current. Every
                  row has the border, so none shifts. The outline is drawn
                  inside, where the scrolling list cannot clip it. */}
              <Link
                to={lessonHref(lesson.slug, playlist.slug)}
                aria-current={current ? "page" : undefined}
                className={`flex items-start gap-2.5 border-l-2 py-1.5 pl-2.5 pr-3 transition-colors hover:bg-slate-800 focus-visible:-outline-offset-2 ${
                  current
                    ? "border-sky-300 bg-slate-800/70 text-white"
                    : "border-transparent text-slate-200"
                }`}
              >
                <span
                  aria-hidden="true"
                  className="flex shrink-0 items-center justify-end font-mono text-xs tabular-nums text-slate-400 size-5"
                >
                  {current ? <Play size={14} className="fill-current text-sky-300" /> : index + 1}
                </span>
                <span className={`min-w-0 flex-1 line-clamp-2 ${current ? "font-semibold" : ""}`}>
                  <LangText text={lesson.title} />
                </span>
                {lesson.duration ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="shrink-0 pt-0.5 text-xs tabular-nums text-slate-400"
                    >
                      {lesson.duration}
                    </span>
                    {/* One text node with its separator: the link's name would
                        otherwise run the title into the time ("…016:10"). */}
                    <span className="sr-only">{`, ${lesson.duration}`}</span>
                  </>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ol>
    </>
  );
}
