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
    <div className="flex h-dvh flex-col bg-[#11141c] font-telegraf text-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-4 py-3 sm:px-6">
        <Link
          to="/learn"
          aria-label="Back to lessons"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/10 px-4 py-1.5 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
        >
          <ArrowLeft className="size-4" />
          Lessons
        </Link>
        <h1 className="truncate font-machina text-sm uppercase tracking-tight text-slate-200">
          {lesson.title}
        </h1>
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
