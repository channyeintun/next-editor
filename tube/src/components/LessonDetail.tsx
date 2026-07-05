import { lazy, Suspense } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { Lesson } from "../types";

// The real editor from the host app. Lazy-loaded so the gallery chunk stays small;
// it only downloads when a viewer opens a lesson. Driven entirely by props (no URL
// query params) — read-only playback of the lesson's recording.
const Editor = lazy(() => import("@app/components/Editor"));

// Rendered inside the editor's own header (via the `breadcrumb` prop) rather than
// a second header stacked above it — the editor chrome already has a slot for it,
// so /learn/:slug doesn't need to spend extra vertical space on its own bar.
function Breadcrumb({ title }: { title: string }) {
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
      <Link
        to="/learn"
        className="shrink-0 font-bold uppercase tracking-wider text-slate-400 transition-colors hover:text-white"
      >
        Lessons
      </Link>
      <ChevronRight className="size-3.5 shrink-0 text-slate-600" />
      <span className="truncate font-machina uppercase tracking-tight text-slate-200">{title}</span>
    </nav>
  );
}

export default function LessonDetail({ lesson }: { lesson: Lesson }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-dvh items-center justify-center bg-[#11141c] text-sm text-slate-400">
          Loading lesson…
        </div>
      }
    >
      <Editor
        readOnly
        recordingUrl={`/${lesson.ne}`}
        breadcrumb={<Breadcrumb title={lesson.title} />}
      />
    </Suspense>
  );
}
