import type { Lesson, LessonsManifest } from "../types";

async function load(): Promise<Lesson[]> {
  const res = await fetch("/lessons.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch lessons: ${res.status}`);
  }
  const data: LessonsManifest = await res.json();
  return data.lessons;
}

// Memoize the in-flight/successful load so navigating grid → lesson doesn't
// refetch (and reflash a spinner) for data we already have. A rejection clears
// the cache so a retry actually hits the network again.
let cache: Promise<Lesson[]> | null = null;

export function fetchLessons(): Promise<Lesson[]> {
  if (!cache) {
    cache = load().catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}
