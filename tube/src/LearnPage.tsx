import Navbar from "@app/components/Navbar";
import { AuthMenu } from "@next-editor/infra";
import LessonGrid from "./components/LessonGrid";

export default function LearnPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar minimal actions={<AuthMenu />} />

      {/* Content-first, like YouTube: straight to the lessons, no marketing copy. */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8">
        <LessonGrid />
      </main>
    </div>
  );
}
