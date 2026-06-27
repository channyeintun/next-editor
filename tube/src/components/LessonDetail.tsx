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
    <div className="relative h-dvh bg-slate-950">
      <Suspense
        fallback={
          <div className="flex h-dvh items-center justify-center text-sm text-slate-400">
            Loading lesson…
          </div>
        }
      >
        <Editor readOnly recordingUrl={`/${lesson.ne}`} />
      </Suspense>

      <Link
        to="/learn"
        aria-label="Back to lessons"
        className="fixed left-4 top-4 z-50 inline-flex items-center gap-1.5 rounded-lg bg-black/70 px-3 py-1.5 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-black/90"
      >
        <ArrowLeft className="size-4" />
        <span className="max-w-[40vw] truncate">{lesson.title}</span>
      </Link>
    </div>
  );
}
