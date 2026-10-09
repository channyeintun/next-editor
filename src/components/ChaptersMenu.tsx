import { useEffect, useId, useRef, useState } from "react";
import { BookmarkPlus, Check, Link, ListVideo, Trash2 } from "lucide-react";
import type { Recording, RecordingChapter } from "../core/src";
import { useLiveTimeValue, useNextEditorActions } from "../hooks/useNextEditorContext";
import {
  defaultChapterTitle,
  findChapterIndexAt,
  formatTimeParameter,
  MAX_CHAPTER_TITLE_LENGTH,
  normalizeChapters,
} from "../core/src/utils/chapters";
import { formatPlaybackTime } from "../utils/formatPlaybackTime";
import { copyTextToClipboard } from "../utils/clipboard";

/** How long a copied-link check mark stays. */
const COPIED_MS = 1_500;

/** This page's address, opening at `timeMs`. An embed's own flags are not part of it. */
export function linkToMoment(timeMs: number): string {
  const url = new URL(window.location.href);
  url.searchParams.set("t", formatTimeParameter(timeMs));
  url.searchParams.delete("embed");
  return url.toString();
}

/** The title of the chapter playing now, beside the timer. */
export function CurrentChapterTitle({
  chapters,
  large = false,
}: {
  chapters: readonly RecordingChapter[];
  large?: boolean;
}) {
  // The chapter, not the time: the title re-renders at chapter boundaries, not every tick.
  const chapterIndex = useLiveTimeValue((time) => findChapterIndexAt(chapters, time));
  const chapter = chapters[chapterIndex];
  if (!chapter) return null;
  return (
    <span
      className={`hidden min-w-0 max-w-48 truncate text-slate-300 pointer-events-auto md:inline ${
        large ? "text-2xl" : "text-xs"
      }`}
      title={chapter.title}
    >
      {chapter.title}
    </span>
  );
}

/**
 * The recording's chapters: jump to one, or copy a link that opens the lesson there.
 * The author (record mode) can also add a chapter at the playhead, rename and delete.
 * A disclosure, not a menu: the panel holds a list, a text field and plain buttons, so it
 * is a labelled group that Tab moves through. Escape closes it and returns to the button.
 */
export default function ChaptersMenu({
  recording,
  editable,
  iconSize,
  buttonClassName,
}: {
  recording: Recording;
  editable: boolean;
  iconSize: number;
  buttonClassName: string;
}) {
  const { seekTo, setChapters } = useNextEditorActions();
  const [open, setOpen] = useState(false);
  const [copiedTime, setCopiedTime] = useState<number | null>(null);
  const panelId = useId();
  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const chapters = recording.chapters ?? [];
  // Only the open menu shows the playhead (the exact time, the chapter playing), so a
  // closed one does not re-render every tick.
  const currentTime = useLiveTimeValue((time) => (open ? time : 0));
  const currentIndex = findChapterIndexAt(chapters, currentTime);

  useEffect(() => {
    if (copiedTime === null) return;
    const timer = setTimeout(() => setCopiedTime(null), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copiedTime]);

  if (!editable && chapters.length === 0) return null;

  const update = (next: RecordingChapter[]) => setChapters(recording.id, normalizeChapters(next));

  const copyLink = (time: number) => {
    copyTextToClipboard(linkToMoment(time));
    setCopiedTime(time);
  };

  return (
    <div className="relative pointer-events-auto">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title="Chapters"
        className={`flex items-center justify-center text-slate-300 transition-colors hover:text-white ${buttonClassName}`}
      >
        <ListVideo size={iconSize} aria-hidden="true" />
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={headingId}
          onKeyDown={(event) => {
            // Not while an input method is composing in the title field: Escape cancels that.
            if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }}
          className="absolute right-0 bottom-full z-46 mb-2 w-72 rounded-lg border border-slate-700 bg-[#151821] py-1.5 text-sm shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
        >
          <p
            id={headingId}
            className="px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-slate-500 uppercase"
          >
            Chapters
          </p>
          {chapters.length === 0 ? (
            <p className="px-3 pb-2 text-xs text-slate-400">
              No chapters yet. Add one where the playhead is.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {chapters.map((chapter, index) => (
                <li
                  key={chapter.time}
                  className={`group flex items-center gap-2 px-3 py-1 ${
                    index === currentIndex ? "bg-slate-800/70" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => seekTo(chapter.time)}
                    className="shrink-0 font-mono text-xs text-sky-300 hover:underline"
                  >
                    {formatPlaybackTime(chapter.time)}
                  </button>
                  {editable ? (
                    <input
                      aria-label={`Title of the chapter at ${formatPlaybackTime(chapter.time)}`}
                      defaultValue={chapter.title}
                      maxLength={MAX_CHAPTER_TITLE_LENGTH}
                      onBlur={(event) => {
                        const title = event.currentTarget.value.trim();
                        if (title === chapter.title) return;
                        update(
                          chapters.map((entry, at) => (at === index ? { ...entry, title } : entry)),
                        );
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-slate-200 outline-none hover:border-slate-700 focus:border-sky-500"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => seekTo(chapter.time)}
                      className="min-w-0 flex-1 truncate text-left text-slate-200"
                    >
                      {chapter.title}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copyLink(chapter.time)}
                    aria-label={`Copy a link to ${chapter.title}`}
                    title="Copy a link to this chapter"
                    className="shrink-0 text-slate-500 transition-colors hover:text-white"
                  >
                    {copiedTime === chapter.time ? (
                      <Check size={13} aria-hidden="true" />
                    ) : (
                      <Link size={13} aria-hidden="true" />
                    )}
                  </button>
                  {editable ? (
                    <button
                      type="button"
                      onClick={() => update(chapters.filter((_, at) => at !== index))}
                      aria-label={`Delete ${chapter.title}`}
                      className="shrink-0 text-slate-500 transition-colors hover:text-red-400"
                    >
                      <Trash2 size={13} aria-hidden="true" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-1 flex flex-col border-t border-slate-700 pt-1">
            {editable ? (
              <button
                type="button"
                onClick={() =>
                  update([
                    ...chapters,
                    { time: currentTime, title: defaultChapterTitle(chapters.length) },
                  ])
                }
                className="flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
              >
                <BookmarkPlus size={13} aria-hidden="true" />
                Add a chapter at {formatPlaybackTime(currentTime)}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => copyLink(currentTime)}
              className="flex items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
            >
              {copiedTime === currentTime ? (
                <Check size={13} aria-hidden="true" />
              ) : (
                <Link size={13} aria-hidden="true" />
              )}
              Copy a link to {formatPlaybackTime(currentTime)}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
