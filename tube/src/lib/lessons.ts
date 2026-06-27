import type { Lesson, LessonsManifest } from "../types";

export async function fetchLessons(): Promise<Lesson[]> {
  const res = await fetch("/lessons.json");
  if (!res.ok) {
    throw new Error(`Failed to fetch lessons: ${res.status}`);
  }
  const data: LessonsManifest = await res.json();
  return data.lessons;
}
