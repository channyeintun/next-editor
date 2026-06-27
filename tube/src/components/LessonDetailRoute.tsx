import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import type { Lesson } from "../types";
import { fetchLessons } from "../lib/lessons";
import LessonDetail from "./LessonDetail";

// Route component for /learn/:slug. Resolves the slug to a lesson (so the detail
// view is deep-linkable with a clean URL and no query params), then renders the
// embedded editor.
export default function LessonDetailRoute() {
  const { slug } = useParams();
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    let active = true;
    setStatus("loading");
    fetchLessons()
      .then((lessons) => {
        if (!active) return;
        const found = lessons.find((l) => l.slug === slug);
        if (found) {
          setLesson(found);
          setStatus("ready");
        } else {
          setStatus("missing");
        }
      })
      .catch(() => active && setStatus("error"));
    return () => {
      active = false;
    };
  }, [slug]);

  if (status === "ready" && lesson) {
    return <LessonDetail lesson={lesson} />;
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-950 text-slate-300">
      {status === "loading" ? (
        <p className="text-sm">Loading lesson…</p>
      ) : (
        <>
          <p className="text-sm">
            {status === "missing" ? "Lesson not found." : "Failed to load lesson."}
          </p>
          <Link
            to="/learn"
            className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20"
          >
            Back to lessons
          </Link>
        </>
      )}
    </div>
  );
}
