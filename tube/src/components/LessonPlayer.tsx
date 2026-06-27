import { useEffect } from "react";
import { X } from "lucide-react";
import type { Lesson } from "../types";
import { buildPlayUrl } from "../lib/links";

interface LessonPlayerProps {
  lesson: Lesson;
  onClose: () => void;
}

export default function LessonPlayer({ lesson, onClose }: LessonPlayerProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm">
      <div className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <h2 className="truncate text-sm font-medium text-white">{lesson.title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close player"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-white/20"
        >
          <X className="size-4" />
          Close
        </button>
      </div>

      <div className="min-h-0 flex-1 px-4 pb-4 sm:px-6 sm:pb-6">
        <iframe
          src={buildPlayUrl(lesson)}
          title={lesson.title}
          className="size-full rounded-xl border border-white/10 bg-slate-950"
          allow="fullscreen; clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
}
