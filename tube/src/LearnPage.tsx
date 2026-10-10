import GalleryShell from "@app/components/GalleryShell";
import { useDocumentTitle } from "@app/hooks/useDocumentTitle";
import { AuthMenu } from "@next-editor/infra";
import LessonGrid from "./components/LessonGrid";

export default function LearnPage() {
  useDocumentTitle("Lessons | Next Editor");

  return (
    // Content-first, like YouTube: straight to the lessons, no marketing copy.
    <GalleryShell actions={<AuthMenu />}>
      {/* No visible title (content-first), but heading navigation still
          needs a top-level heading naming the view. */}
      <h1 className="sr-only">Lessons</h1>
      <LessonGrid />
    </GalleryShell>
  );
}
