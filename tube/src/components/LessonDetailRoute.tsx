import type { ReactNode } from "react";
import { Link, useParams } from "react-router";
import { useLesson } from "../hooks/useLessons";
import { lessonPageTitle } from "../lib/lessonPageTitle";
import LessonDetail from "./LessonDetail";
import LessonPageSkeleton from "@app/components/LessonPageSkeleton";
import { useDocumentTitle } from "@app/hooks/useDocumentTitle";

// Route component for /learn/:slug. Resolves the slug to a lesson (so the detail
// view is deep-linkable with a clean URL and no query params), then renders the
// embedded editor. Shares the cached lessons manifest with the gallery, so
// arriving from the grid is instant.
export default function LessonDetailRoute() {
  const { slug } = useParams();
  const lessonQuery = useLesson(slug);
  const { data: lesson, isPending, isError } = lessonQuery;
  // Here rather than in LessonDetail, so the pending and not-found states and a
  // playlist's auto-advance to the next slug all retitle the page.
  useDocumentTitle(lessonPageTitle(slug, lessonQuery));

  // The editor shell rather than a lone spinner: this gate is one of several on
  // the way to a playable lesson (route chunk → this view's chunk → this lookup
  // → CodeEditor/Monaco), and they all paint the same layout, so the page
  // assembles in place instead of flashing between unrelated screens.
  if (isPending) {
    return <LessonPageSkeleton slug={slug} />;
  }

  if (lesson) {
    return <LessonDetail lesson={lesson} />;
  }

  // lesson === null → no slug match; isError → fetch failed.
  return (
    <Centered>
      <p className="text-sm">{isError ? "Failed to load lesson." : "Lesson not found."}</p>
      <Link
        to="/learn"
        className="rounded-full border border-white/10 bg-white/10 px-5 py-2 text-sm font-semibold text-white transition-all hover:bg-white hover:text-slate-950"
      >
        Back to lessons
      </Link>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-[#11141c] font-telegraf text-slate-300">
      {children}
    </div>
  );
}
