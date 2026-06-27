import Navbar from "@app/components/Navbar";
import LessonGrid from "./components/LessonGrid";
import Footer from "./components/Footer";

export default function LearnPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar />

      {/* Content-first, like YouTube: straight to the lessons, no marketing copy. */}
      <main className="mx-auto w-full max-w-7xl flex-1 px-6 pb-20 pt-2 sm:px-8">
        <LessonGrid />
      </main>

      <Footer />
    </div>
  );
}
