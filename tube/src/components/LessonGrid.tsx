import { useEffect, useState } from "react";
import type { Lesson } from "../types";
import { fetchLessons } from "../lib/lessons";
import LessonCard from "./LessonCard";
import SearchBar from "./SearchBar";

export default function LessonGrid() {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetchLessons()
      .then(setLessons)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load lessons"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = query
    ? lessons.filter((l) => {
        const q = query.toLowerCase();
        return (
          l.title.toLowerCase().includes(q) ||
          l.description.toLowerCase().includes(q) ||
          l.tags?.some((t) => t.toLowerCase().includes(q))
        );
      })
    : lessons;

  if (loading) {
    return <div className="flex justify-center py-20 text-slate-400">Loading lessons...</div>;
  }

  if (error) {
    return <div className="flex justify-center py-20 text-red-400">{error}</div>;
  }

  return (
    <div>
      {lessons.length > 0 && <SearchBar value={query} onChange={setQuery} />}

      {filtered.length === 0 ? (
        <div className="flex justify-center py-20 text-slate-400">
          {lessons.length === 0 ? "No lessons yet." : "No lessons match your search."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((lesson) => (
            <LessonCard key={lesson.slug} lesson={lesson} />
          ))}
        </div>
      )}
    </div>
  );
}
