import { lazy, Suspense } from "react";
import type { Lesson } from "../types";
import Breadcrumb from "./Breadcrumb";

// The real editor from the host app. Lazy-loaded so the gallery chunk stays small;
// it only downloads when a viewer opens a lesson. Driven entirely by props (no URL
// query params) — read-only playback of the lesson's recording.
const Editor = lazy(() => import("@app/components/Editor"));

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
