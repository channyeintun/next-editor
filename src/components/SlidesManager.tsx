import { useState, useCallback } from "react";
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Edit3,
  Play,
  X,
  Code,
  FileText,
  Save,
  RotateCcw,
  Monitor,
} from "lucide-react";
import type { Slide, SlideContentType } from "../types/slides";

interface SlidesManagerProps {
  slides: Slide[];
  onSlidesChange: (slides: Slide[]) => void;
  onStartPresentation?: () => void;
  onClose?: () => void;
}

const DEFAULT_HTML_CONTENT = `<h1>Welcome</h1>
<p>Your slide content here</p>`;

const DEFAULT_MARKDOWN_CONTENT = `# Welcome

Your slide content here`;

function getPreviewText(content: string): string {
  const lines = content.split("\n").filter((line) => line.trim());
  const firstLine = lines[0] || "Empty slide";

  return (
    firstLine
      .replace(/<[^>]*>/g, "")
      .replace(/^#+\s*/, "")
      .substring(0, 40) + (firstLine.length > 40 ? "..." : "")
  );
}

export default function SlidesManager({
  slides,
  onSlidesChange,
  onStartPresentation,
  onClose,
}: SlidesManagerProps) {
  const [newSlideContent, setNewSlideContent] = useState("");
  const [contentType, setContentType] = useState<SlideContentType>("markdown");
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");

  const addSlide = useCallback(() => {
    const content =
      newSlideContent.trim() ||
      (contentType === "html" ? DEFAULT_HTML_CONTENT : DEFAULT_MARKDOWN_CONTENT);

    const newSlide: Slide = {
      id: Date.now().toString(),
      content,
      contentType,
      order: slides.length,
    };

    onSlidesChange([...slides, newSlide]);
    setNewSlideContent("");
  }, [newSlideContent, contentType, slides, onSlidesChange]);

  const removeSlide = useCallback(
    (slideId: string) => {
      const updatedSlides = slides
        .filter((slide) => slide.id !== slideId)
        .map((slide, index) => ({ ...slide, order: index }));
      onSlidesChange(updatedSlides);
    },
    [slides, onSlidesChange],
  );

  const moveSlide = useCallback(
    (slideId: string, direction: "up" | "down") => {
      const slideIndex = slides.findIndex((slide) => slide.id === slideId);
      if (slideIndex === -1) return;

      const newIndex = direction === "up" ? slideIndex - 1 : slideIndex + 1;
      if (newIndex < 0 || newIndex >= slides.length) return;

      const updatedSlides = [...slides];
      [updatedSlides[slideIndex], updatedSlides[newIndex]] = [
        updatedSlides[newIndex],
        updatedSlides[slideIndex],
      ];

      // Update order numbers
      updatedSlides.forEach((slide, index) => {
        slide.order = index;
      });

      onSlidesChange(updatedSlides);
    },
    [slides, onSlidesChange],
  );

  const startEditing = useCallback((slide: Slide) => {
    setEditingSlideId(slide.id);
    setEditContent(slide.content);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingSlideId) return;

    const updatedSlides = slides.map((slide) =>
      slide.id === editingSlideId ? { ...slide, content: editContent } : slide,
    );
    onSlidesChange(updatedSlides);
    setEditingSlideId(null);
    setEditContent("");
  }, [editingSlideId, editContent, slides, onSlidesChange]);

  const cancelEdit = useCallback(() => {
    setEditingSlideId(null);
    setEditContent("");
  }, []);

  return (
    <div className="flex max-h-[calc(100dvh-120px)] w-full flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#151821] shadow-[0_18px_40px_rgba(2,6,23,0.45)] sm:w-105 sm:max-h-160">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-[#151821] px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center rounded-md border border-slate-700 bg-[#1d1f29] size-8">
            <Monitor className="text-cyan-300 size-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-slate-100">
              Presentation Slides
            </h3>
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Reveal.js powered
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white"
              title="Close"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div className="editor-scrollbar flex-1 space-y-5 overflow-y-auto p-5">
        {/* Add Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#11141c] p-1">
            <button
              type="button"
              onClick={() => setContentType("markdown")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                contentType === "markdown"
                  ? "border-slate-600 bg-slate-700 text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <FileText className="size-3.5 text-cyan-300" />
                Markdown
              </span>
            </button>
            <button
              type="button"
              onClick={() => setContentType("html")}
              className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                contentType === "html"
                  ? "border-slate-600 bg-slate-700 text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200"
              }`}
            >
              <span className="flex items-center justify-center gap-2">
                <Code className="size-3.5 text-sky-300" />
                HTML
              </span>
            </button>
          </div>

          <div className="relative group">
            <textarea
              value={newSlideContent}
              onChange={(e) => setNewSlideContent(e.target.value)}
              placeholder={
                contentType === "html"
                  ? "<h1>Title</h1>\n<p>Content</p>"
                  : "# Title\n\nContent here..."
              }
              className="h-32 w-full resize-none rounded-lg border border-slate-700 bg-[#11141c] px-4 py-3 font-mono text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/70"
            />
          </div>

          <button
            type="button"
            onClick={addSlide}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-[#5da4ff]/40 bg-[#273449] py-2.5 text-sm font-semibold text-slate-100 transition-colors hover:border-[#5da4ff] hover:bg-[#32435c] active:scale-[0.99]"
          >
            <Plus className="size-4" />
            Create Slide
          </button>
        </div>

        {/* List Section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
              Your Presentation
            </h4>
            <span className="rounded-full border border-slate-700 bg-[#1d1f29] px-2 py-0.5 text-[10px] text-slate-400">
              {slides.length} {slides.length === 1 ? "slide" : "slides"}
            </span>
          </div>

          {slides.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 bg-[#11141c] px-6 py-10 text-center">
              <div className="mx-auto mb-4 flex items-center justify-center rounded-lg border border-slate-700 bg-[#1d1f29] size-12">
                <Monitor className="text-slate-500 size-6" />
              </div>
              <p className="text-xs font-medium leading-relaxed text-slate-400">
                Your presentation deck is empty.
                <br />
                Craft your first slide above.
              </p>
            </div>
          ) : (
            <div className="space-y-3 pb-4">
              {slides.map((slide, index) => (
                <div
                  key={slide.id}
                  className="group relative overflow-hidden rounded-lg border border-slate-800 bg-[#11141c] p-3 transition-colors hover:border-slate-700 hover:bg-[#1b2029]"
                >
                  {editingSlideId === slide.id ? (
                    <div className="space-y-3">
                      <textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="h-32 w-full resize-none rounded-lg border border-slate-700 bg-[#0f1219] px-3 py-2 font-mono text-xs text-slate-200 outline-none transition-colors focus:border-cyan-400/70"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={saveEdit}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[#10c776] py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-[#39f39a]"
                        >
                          <Save className="size-3" />
                          Update
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-600"
                          aria-label="Cancel editing slide"
                          title="Cancel"
                        >
                          <RotateCcw className="size-3" />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-4">
                      {/* Left: Thumbnail area */}
                      <div
                        className="group/thumb relative h-11 w-14 shrink-0 cursor-pointer overflow-hidden rounded-md border border-slate-700 bg-[#151821] transition-shadow hover:ring-2 hover:ring-cyan-400/40"
                        onClick={() => startEditing(slide)}
                      >
                        <div className="absolute inset-0 flex items-center justify-center">
                          {slide.contentType === "html" ? (
                            <Code className="text-sky-300/60 size-4" />
                          ) : (
                            <FileText className="text-cyan-300/60 size-4" />
                          )}
                        </div>
                        <div className="absolute right-0 top-0 border-b border-l border-slate-700 bg-slate-800 px-1 py-0.5 text-[6px] font-bold uppercase leading-none text-slate-400">
                          {slide.contentType}
                        </div>
                        <div className="absolute inset-0 flex items-center justify-center bg-cyan-400/10 py-1 opacity-0 transition-opacity group-hover/thumb:opacity-100">
                          <Edit3 className="text-white size-3" />
                        </div>
                      </div>

                      {/* Center: Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[10px] font-semibold text-slate-500">
                            #{index + 1}
                          </span>
                          <span className="h-px flex-1 bg-slate-800"></span>
                        </div>
                        <p className="truncate text-xs font-semibold text-slate-200 transition-colors group-hover:text-cyan-200">
                          {getPreviewText(slide.content)}
                        </p>
                      </div>

                      {/* Right: Actions */}
                      <div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => moveSlide(slide.id, "up")}
                          disabled={index === 0}
                          className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                          title="Move Up"
                        >
                          <ChevronUp className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveSlide(slide.id, "down")}
                          disabled={index === slides.length - 1}
                          className="rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
                          title="Move Down"
                        >
                          <ChevronDown className="size-3.5" />
                        </button>
                        <div className="mx-1 h-4 w-px bg-slate-800"></div>
                        <button
                          type="button"
                          onClick={() => removeSlide(slide.id)}
                          className="rounded-md p-1.5 text-rose-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                          title="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer / CTA */}
      <div className="border-t border-slate-800 bg-[#151821] p-5">
        <button
          type="button"
          onClick={onStartPresentation}
          disabled={slides.length === 0}
          className="group flex w-full items-center justify-center gap-3 rounded-md bg-[#10c776] py-3 text-sm font-semibold uppercase tracking-[0.08em] text-slate-950 transition-colors hover:bg-[#39f39a] disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-600 active:scale-[0.99]"
        >
          <Play className="fill-current group-enabled:group-hover:translate-x-0.5 transition-transform size-5" />
          START PRESENTATION
        </button>
      </div>
    </div>
  );
}
