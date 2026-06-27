import { useSearchParams } from "react-router";
import type { Lesson } from "./types";
import Header from "./components/Header";
import LessonGrid from "./components/LessonGrid";
import LessonDetail from "./components/LessonDetail";
import Footer from "./components/Footer";

export default function LearnPage() {
  const [params, setParams] = useSearchParams();

  // A selected lesson is encoded in the URL the same way the editor consumes it
  // (?url=...&readOnly=true), so the embedded Editor picks it up directly.
  const selectedUrl = params.get("url");
  const selectedTitle = params.get("title") ?? "Lessons";

  const openLesson = (lesson: Lesson) => {
    setParams({
      url: `/${lesson.ne}`,
      title: lesson.title,
      readOnly: "true",
      deferRuntimeAutostart: "true",
    });
  };

  const closeLesson = () => setParams({});

  if (selectedUrl) {
    return <LessonDetail title={selectedTitle} onBack={closeLesson} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-slate-950 text-white">
      <Header />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6">
        <LessonGrid onOpen={openLesson} />
      </main>
      <Footer />
    </div>
  );
}
