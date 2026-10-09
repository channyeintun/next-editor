import { useId, useRef, useState, type ReactElement } from "react";
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
  Upload,
  Loader2,
  Presentation,
  Download,
  ExternalLink,
} from "lucide-react";
import type { Slide, SlideContentType } from "../types/slides";
import {
  SLIDE_BACKGROUND_PRESETS,
  getSlideBackgroundImage,
  isCustomSlideBackground,
  readCustomBackgroundImage,
  CustomBackgroundError,
} from "../config/slideBackgrounds";
import { fetchPublishedDeck, GoogleSlidesParseError } from "../googleSlides";
import { applyDeckToSlides } from "../googleSlides/importDeck";

/** Guards an href/fetch target that came out of deserialized slide data. */
function isHttpsUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

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

/** Each slide type's thumbnail icon. */
const SLIDE_TYPE_ICONS: Record<SlideContentType, ReactElement> = {
  "google-svg": <Presentation className="text-amber-300/70 size-4" />,
  html: <Code className="text-sky-300/60 size-4" />,
  markdown: <FileText className="text-cyan-300/60 size-4" />,
};

/**
 * A slide's thumbnail icon. A recording's deck reaches the store unchecked, so a slide
 * with no type or an unknown one gets the Markdown icon, and an inherited name such as
 * "constructor" never resolves.
 */
function slideTypeIcon(contentType: SlideContentType): ReactElement {
  return Object.hasOwn(SLIDE_TYPE_ICONS, contentType)
    ? SLIDE_TYPE_ICONS[contentType]
    : SLIDE_TYPE_ICONS.markdown;
}

function BackgroundPicker({
  value,
  onChange,
  noneBgClass,
}: {
  value: string | undefined;
  onChange: (background: string | undefined) => void;
  noneBgClass: string;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const customImage = isCustomSlideBackground(value) ? getSlideBackgroundImage(value) : undefined;

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setIsUploading(true);
    setError(null);
    // No `finally`: the React Compiler skips a component with one. The catch cannot
    // throw, so the line after it runs on every path, as a finally would.
    try {
      const dataUrl = await readCustomBackgroundImage(file);
      onChange(dataUrl);
    } catch (err) {
      // No timer clears this: it stays until the next background choice, so it can be
      // read at any pace.
      setError(err instanceof CustomBackgroundError ? err.message : "Couldn't use that image.");
    }
    setIsUploading(false);
  };

  const choose = (background: string | undefined) => {
    setError(null);
    onChange(background);
  };

  return (
    <div className="space-y-1.5">
      <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        Background
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => choose(undefined)}
          title="None"
          aria-label="No background"
          aria-pressed={!value}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${noneBgClass} text-[10px] font-semibold text-slate-500 transition-colors ${
            !value
              ? "border-cyan-400/70 ring-1 ring-cyan-400/40"
              : "border-slate-700 hover:border-slate-600"
          }`}
        >
          None
        </button>
        {SLIDE_BACKGROUND_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => choose(preset.id)}
            title={preset.label}
            aria-label={preset.label}
            aria-pressed={value === preset.id}
            style={{
              backgroundImage: `url(${preset.imagePath})`,
              backgroundSize: "cover",
            }}
            className={`size-7 shrink-0 rounded-md border transition-colors ${
              value === preset.id
                ? "border-cyan-400/70 ring-1 ring-cyan-400/40"
                : "border-slate-700 hover:border-slate-600"
            }`}
          />
        ))}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          title={customImage ? "Replace custom image" : "Upload image"}
          aria-label={
            customImage ? "Replace custom background image" : "Upload custom background image"
          }
          aria-pressed={!!customImage}
          style={
            customImage
              ? { backgroundImage: `url(${customImage})`, backgroundSize: "cover" }
              : undefined
          }
          className={`flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors disabled:opacity-60 ${
            customImage
              ? "border-cyan-400/70 ring-1 ring-cyan-400/40"
              : `border-dashed ${noneBgClass} border-slate-700 hover:border-slate-600`
          }`}
        >
          {isUploading ? (
            <Loader2 className="size-3.5 animate-spin text-slate-400" />
          ) : (
            !customImage && <Upload className="size-3.5 text-slate-500" />
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
      {error && (
        <p role="alert" className="text-[10px] text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

function getPreviewText(slide: Slide, index: number): string {
  if (slide.contentType === "google-svg") {
    return slide.title?.trim() || `Slide ${index + 1}`;
  }

  const lines = slide.content.split("\n").filter((line) => line.trim());
  const firstLine = lines[0] || "Empty slide";

  return (
    firstLine
      .replace(/<[^>]*>/g, "")
      .replace(/^#+\s*/, "")
      .substring(0, 40) + (firstLine.length > 40 ? "..." : "")
  );
}

function GoogleSlidesImport({
  slides,
  onSlidesChange,
}: {
  slides: Slide[];
  onSlidesChange: (slides: Slide[]) => void;
}) {
  const [url, setUrl] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const googleSlides = slides.filter((slide) => slide.contentType === "google-svg");
  // Only the *import* path validates this URL (isPublishedDeckUrl). Slides
  // deserialized from a `.ne`, a studio plan, or the collaboration teaching
  // document carry an unvalidated string that is also persisted to
  // localStorage — so a `javascript:` URL would execute in the app origin on
  // click, and runImport below would re-fetch an arbitrary host from the
  // viewer's browser. Re-check the scheme at the point of use.
  const rawSourceUrl = googleSlides.find((slide) => slide.sourceUrl)?.sourceUrl;
  const sourceUrl = isHttpsUrl(rawSourceUrl) ? rawSourceUrl : undefined;

  const runImport = async (deckUrl: string) => {
    setIsLoading(true);
    setError(null);
    // No `finally`: the React Compiler skips a component with one. The catch cannot
    // throw, so the line after it runs on every path, as a finally would.
    try {
      const deck = await fetchPublishedDeck(deckUrl);
      onSlidesChange(applyDeckToSlides(slides, deck));
      setUrl("");
    } catch (err) {
      setError(
        err instanceof GoogleSlidesParseError
          ? err.message
          : "Couldn't import that deck. Please try again.",
      );
    }
    setIsLoading(false);
  };

  const removeDeck = () => {
    onSlidesChange(
      slides
        .filter((slide) => slide.contentType !== "google-svg")
        .map((slide, index) => ({ ...slide, order: index })),
    );
    setError(null);
  };

  if (sourceUrl) {
    return (
      <div className="space-y-2 rounded-lg border border-slate-800 bg-[#11141c] p-3">
        <div className="flex items-center gap-2">
          <Presentation className="size-4 shrink-0 text-amber-300" />
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-300">
            {googleSlides.length} {googleSlides.length === 1 ? "slide" : "slides"} from{" "}
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-0.5 text-cyan-300 hover:underline"
            >
              Google Slides <ExternalLink className="size-3" />
            </a>
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => runImport(sourceUrl)}
            disabled={isLoading}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-[#1d1f29] py-1.5 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 disabled:opacity-60"
          >
            {isLoading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            Update
          </button>
          <button
            type="button"
            onClick={removeDeck}
            disabled={isLoading}
            className="rounded-md border border-slate-700 bg-[#1d1f29] px-3 py-1.5 text-xs font-medium text-rose-300 transition-colors hover:border-rose-500/50 disabled:opacity-60"
          >
            Remove deck
          </button>
        </div>
        {error && (
          <p role="alert" className="text-[10px] text-rose-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-800 bg-[#11141c] p-3">
      <div className="flex items-center gap-2">
        <Presentation className="size-4 shrink-0 text-amber-300" />
        <span className="text-xs font-semibold text-slate-200">Import from Google Slides</span>
      </div>
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() && !isLoading) runImport(url.trim());
          }}
          placeholder="https://docs.google.com/presentation/d/e/…/pub"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-[#0f1219] px-3 py-1.5 text-xs text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-400/70"
        />
        <button
          type="button"
          onClick={() => runImport(url.trim())}
          disabled={isLoading || !url.trim()}
          className="flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-[#5da4ff]/40 bg-[#273449] px-3 py-1.5 text-xs font-semibold text-slate-100 transition-colors hover:border-[#5da4ff] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          Import
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">
        In Google Slides: File → Share → Publish to web, then paste the published link here.
      </p>
      {error && (
        <p id={errorId} role="alert" className="text-[10px] text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}

type NewSlide = Pick<Slide, "content" | "contentType" | "background">;

/**
 * Picks a new slide's type, text and background. An empty text becomes that type's
 * starter content; after a slide is created the text and background clear, the type
 * stays.
 */
function NewSlideForm({ onCreate }: { onCreate: (slide: NewSlide) => void }) {
  const [newSlideContent, setNewSlideContent] = useState("");
  const [contentType, setContentType] = useState<SlideContentType>("markdown");
  const [background, setBackground] = useState<string | undefined>(undefined);

  const addSlide = () => {
    const content =
      newSlideContent.trim() ||
      (contentType === "html" ? DEFAULT_HTML_CONTENT : DEFAULT_MARKDOWN_CONTENT);

    onCreate({ content, contentType, background });
    setNewSlideContent("");
    setBackground(undefined);
  };

  return (
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
            contentType === "html" ? "<h1>Title</h1>\n<p>Content</p>" : "# Title\n\nContent here..."
          }
          className="h-32 w-full resize-none rounded-lg border border-slate-700 bg-[#11141c] px-4 py-3 font-mono text-sm text-slate-200 outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-400/70"
        />
      </div>

      <BackgroundPicker value={background} onChange={setBackground} noneBgClass="bg-[#11141c]" />

      <button
        type="button"
        onClick={addSlide}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-[#5da4ff]/40 bg-[#273449] py-2.5 text-sm font-semibold text-slate-100 transition-colors hover:border-[#5da4ff] hover:bg-[#32435c] active:scale-[0.99]"
      >
        <Plus className="size-4" />
        Create Slide
      </button>
    </div>
  );
}

export default function SlidesManager({
  slides,
  onSlidesChange,
  onStartPresentation,
  onClose,
}: SlidesManagerProps) {
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editBackground, setEditBackground] = useState<string | undefined>(undefined);
  const listRef = useRef<HTMLDivElement | null>(null);

  const addSlide = ({ content, contentType, background }: NewSlide) => {
    const newSlide: Slide = {
      id: Date.now().toString(),
      content,
      contentType,
      order: slides.length,
      background,
    };

    onSlidesChange([...slides, newSlide]);
  };

  const removeSlide = (slideId: string) => {
    const updatedSlides = slides
      .filter((slide) => slide.id !== slideId)
      .map((slide, index) => ({ ...slide, order: index }));
    onSlidesChange(updatedSlides);
  };

  const moveSlide = (slideId: string, direction: "up" | "down") => {
    const slideIndex = slides.findIndex((slide) => slide.id === slideId);
    if (slideIndex === -1) return;

    const newIndex = direction === "up" ? slideIndex - 1 : slideIndex + 1;
    if (newIndex < 0 || newIndex >= slides.length) return;

    const reordered = [...slides];
    [reordered[slideIndex], reordered[newIndex]] = [reordered[newIndex], reordered[slideIndex]];

    // New objects, like removeSlide: the slides handed in may be the ones a
    // finished take or a loaded lesson still holds.
    onSlidesChange(reordered.map((slide, index) => ({ ...slide, order: index })));
  };

  const startEditing = (slide: Slide) => {
    // Imported Google slides are vector artwork, not hand-editable text.
    if (slide.contentType === "google-svg") return;
    setEditingSlideId(slide.id);
    setEditContent(slide.content);
    setEditBackground(slide.background);
  };

  /**
   * Puts focus back on a slide's thumbnail once its editor has closed: the Update and
   * Cancel buttons unmount with the editor, which would otherwise drop focus to the page.
   */
  const focusThumbnail = (slideId: string) => {
    requestAnimationFrame(() => {
      const thumbnails = listRef.current?.querySelectorAll<HTMLElement>("[data-slide-thumb]");
      [...(thumbnails ?? [])].find((thumb) => thumb.dataset.slideThumb === slideId)?.focus();
    });
  };

  const saveEdit = () => {
    if (!editingSlideId) return;

    const updatedSlides = slides.map((slide) =>
      slide.id === editingSlideId
        ? { ...slide, content: editContent, background: editBackground }
        : slide,
    );
    onSlidesChange(updatedSlides);
    setEditingSlideId(null);
    setEditContent("");
    setEditBackground(undefined);
    focusThumbnail(editingSlideId);
  };

  const cancelEdit = () => {
    if (editingSlideId) focusThumbnail(editingSlideId);
    setEditingSlideId(null);
    setEditContent("");
    setEditBackground(undefined);
  };

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
              Slide presentations
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
        {/* Import from Google Slides */}
        <GoogleSlidesImport slides={slides} onSlidesChange={onSlidesChange} />

        {/* Add Section */}
        <NewSlideForm onCreate={addSlide} />

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
            <div ref={listRef} className="space-y-3 pb-4">
              {slides.map((slide, index) => {
                const backgroundImage = getSlideBackgroundImage(slide.background);
                // Imported Google slides are artwork, so their thumbnail is not a control.
                const isEditable = slide.contentType !== "google-svg";
                const typeLabel = isEditable ? slide.contentType : "slides";
                const thumbClass =
                  "group/thumb relative h-11 w-14 shrink-0 overflow-hidden rounded-md border border-slate-700 bg-[#151821]";
                const thumbStyle = backgroundImage
                  ? { backgroundImage: `url(${backgroundImage})`, backgroundSize: "cover" }
                  : undefined;
                // Spans, not divs: this sits inside a button, which takes phrasing content.
                const thumbContent = (
                  <>
                    {backgroundImage && <span className="absolute inset-0 bg-[#151821]/50" />}
                    <span className="absolute inset-0 flex items-center justify-center">
                      {slideTypeIcon(slide.contentType)}
                    </span>
                    <span className="absolute right-0 top-0 border-b border-l border-slate-700 bg-slate-800 px-1 py-0.5 text-[6px] font-bold uppercase leading-none text-slate-400">
                      {typeLabel}
                    </span>
                  </>
                );

                return (
                  <div
                    key={slide.id}
                    className="group relative overflow-hidden rounded-lg border border-slate-800 bg-[#11141c] p-3 transition-colors hover:border-slate-700 hover:bg-[#1b2029]"
                  >
                    {editingSlideId === slide.id ? (
                      <div className="space-y-3">
                        <textarea
                          // The thumbnail that opened the editor unmounts; focus moves here
                          // rather than falling back to the page.
                          autoFocus
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                          className="h-32 w-full resize-none rounded-lg border border-slate-700 bg-[#0f1219] px-3 py-2 font-mono text-xs text-slate-200 outline-none transition-colors focus:border-cyan-400/70"
                        />
                        <BackgroundPicker
                          value={editBackground}
                          onChange={setEditBackground}
                          noneBgClass="bg-[#0f1219]"
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
                        {isEditable ? (
                          <button
                            type="button"
                            onClick={() => startEditing(slide)}
                            // Names the slide by its visible corner label, so the spoken
                            // name contains what is on screen. A recording's deck reaches
                            // the store unchecked, so that label can be missing.
                            aria-label={
                              typeLabel
                                ? `Edit ${typeLabel} slide ${index + 1}`
                                : `Edit slide ${index + 1}`
                            }
                            data-slide-thumb={slide.id}
                            className={`${thumbClass} cursor-pointer transition-shadow hover:ring-2 hover:ring-cyan-400/40`}
                            style={thumbStyle}
                          >
                            {thumbContent}
                            <span className="absolute inset-0 flex items-center justify-center bg-cyan-400/10 py-1 opacity-0 transition-opacity group-hover/thumb:opacity-100 group-focus-visible/thumb:opacity-100">
                              <Edit3 className="text-white size-3" />
                            </span>
                          </button>
                        ) : (
                          <div className={thumbClass} style={thumbStyle}>
                            {thumbContent}
                          </div>
                        )}

                        {/* Center: Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[10px] font-semibold text-slate-500">
                              #{index + 1}
                            </span>
                            <span className="h-px flex-1 bg-slate-800"></span>
                          </div>
                          <p className="truncate text-xs font-semibold text-slate-200 transition-colors group-hover:text-cyan-200">
                            {getPreviewText(slide, index)}
                          </p>
                        </div>

                        {/* Right: Actions (revealed on hover, and whenever focus is in the card) */}
                        <div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100 sm:group-focus-within:opacity-100">
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
                );
              })}
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
