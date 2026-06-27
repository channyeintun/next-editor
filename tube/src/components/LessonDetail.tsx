import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";
import type { Lesson } from "../types";

// The real editor from the host app. Lazy-loaded so the gallery chunk stays small;
// it only downloads when a viewer opens a lesson. Driven entirely by props (no URL
// query params) — read-only playback of the lesson's recording.
const Editor = lazy(() => import("@app/components/Editor"));

export default function LessonDetail({ lesson }: { lesson: Lesson }) {
  return (
    <div className="flex h-dvh flex-col bg-slate-950 text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-2.5">
        <Link
          to="/learn"
          aria-label="Back to lessons"
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <ArrowLeft className="size-4" />
          Lessons
        </Link>
        <h1 className="truncate text-sm font-medium text-slate-200">{lesson.title}</h1>
      </header>

      <div className="relative min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex size-full items-center justify-center text-sm text-slate-400">
              Loading lesson…
            </div>
          }
        >
          <Editor readOnly fill recordingUrl={`/${lesson.ne}`} />
        </Suspense>
      </div>
    </div>
  );
}
