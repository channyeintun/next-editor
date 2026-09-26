import type { RecordingChapter } from "../types";

// ============================================================================
// Chapters: named points in a recording, to jump to and to show where a long
// lesson is.
// ============================================================================

/** Longer titles are cut here: a chapter names a stretch, it does not describe it. */
export const MAX_CHAPTER_TITLE_LENGTH = 120;

export const defaultChapterTitle = (index: number) => `Chapter ${index + 1}`;

/**
 * Chapters sorted by time, one per moment, with usable titles. Anything that is not a
 * chapter is dropped, so a file's header can be passed as is.
 */
export function normalizeChapters(chapters: readonly unknown[]): RecordingChapter[] {
  const valid = chapters
    .filter(
      (chapter): chapter is RecordingChapter =>
        typeof chapter === "object" &&
        chapter !== null &&
        Number.isFinite((chapter as RecordingChapter).time) &&
        typeof (chapter as RecordingChapter).title === "string",
    )
    .map((chapter) => ({
      time: Math.max(0, chapter.time),
      title: chapter.title.trim().slice(0, MAX_CHAPTER_TITLE_LENGTH),
    }))
    .sort((left, right) => left.time - right.time);

  // Two chapters at one moment name the same stretch: the later one wins.
  const byMoment: RecordingChapter[] = [];
  for (const chapter of valid) {
    const last = byMoment[byMoment.length - 1];
    if (last && last.time === chapter.time) byMoment[byMoment.length - 1] = chapter;
    else byMoment.push(chapter);
  }
  return byMoment.map((chapter, index) => ({
    ...chapter,
    title: chapter.title || defaultChapterTitle(index),
  }));
}

/** The chapter playing at `time`: the last one that started at or before it, or -1. */
export function findChapterIndexAt(chapters: readonly RecordingChapter[], time: number): number {
  let low = 0;
  let high = chapters.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (chapters[middle].time <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * A time from a link: seconds (`90`, `90.5`, `90s`), a clock (`1:30`, `1:02:03`), or
 * units (`1h2m3s`, `2m`). Milliseconds, or null for anything else.
 */
export function parseTimeParameter(value: string | null | undefined): number | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;

  if (/^\d+(\.\d+)?s?$/.test(text)) {
    return Math.round(Number.parseFloat(text) * 1000);
  }
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(text)) {
    const parts = text.split(":").map(Number.parseFloat);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Math.round(seconds * 1000);
  }
  const units = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(text);
  if (units && (units[1] || units[2] || units[3])) {
    const [, hours = "0", minutes = "0", seconds = "0"] = units;
    return Math.round(
      (Number(hours) * 3600 + Number(minutes) * 60 + Number.parseFloat(seconds)) * 1000,
    );
  }
  return null;
}

/** The link parameter for a moment: whole seconds, which every player understands. */
export const formatTimeParameter = (timeMs: number) =>
  String(Math.max(0, Math.floor(timeMs / 1000)));
