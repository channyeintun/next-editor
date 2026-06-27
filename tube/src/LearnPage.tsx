import Navbar from "@app/components/Navbar";
import LessonGrid from "./components/LessonGrid";
import Footer from "./components/Footer";

export default function LearnPage() {
  return (
    <div className="min-h-dvh overflow-hidden bg-[#11141c] font-telegraf text-white selection:bg-pinata-purple selection:text-white">
      <Navbar />

      <main className="relative mx-auto max-w-7xl px-6 pb-24 pt-4 sm:px-8">
        {/* Brand colorful blobs, matching the landing page */}
        <div className="pointer-events-none absolute left-0 top-0 -z-10 size-full overflow-hidden">
          <div className="absolute right-[-5%] top-[-10%] size-87.5 rounded-full bg-[radial-gradient(circle,hsla(248,100%,67%,0.25)_0%,hsla(248,100%,67%,0)_70%)] md:size-150" />
          <div className="absolute bottom-[20%] left-[-10%] size-75 rounded-full bg-[radial-gradient(circle,hsla(174,76%,60%,0.18)_0%,hsla(174,76%,60%,0)_70%)] md:size-125" />
        </div>

        <header className="mb-10 max-w-2xl">
          <h1 className="font-machina text-4xl uppercase leading-[0.95] tracking-tight sm:text-5xl">
            Lessons
          </h1>
          <p className="mt-4 text-lg text-slate-400">
            Watch real coding sessions replay step by step — then run and edit them yourself, right
            in the browser.
          </p>
        </header>

        <LessonGrid />
      </main>

      <Footer />
    </div>
  );
}
