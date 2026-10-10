import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { DEFAULT_THUMBNAIL_PATH } from "../../lessons/defaultThumbnail";
import { prepareThumbnail } from "./prepareThumbnail";
import { THUMBNAIL_ACCEPT } from "./thumbnailConstraints";

/** What the lesson's card will show: nothing yet, the site default, or a picked image. */
export type ThumbnailSelection =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "file"; file: File };

interface UploadThumbnailFieldProps {
  value: ThumbnailSelection;
  onChange: (value: ThumbnailSelection) => void;
  disabled: boolean;
}

// The upload form's thumbnail picker. The form owns the selection it uploads;
// this owns checking a picked image and previewing it.
export default function UploadThumbnailField({
  value,
  onChange,
  disabled,
}: UploadThumbnailFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const file = value.kind === "file" ? value.file : null;
  // Kept with the file it shows, so a URL revoked below is never rendered.
  const previewUrl = file && preview?.file === file ? preview.url : null;

  // One object URL per selected file, revoked whenever the selection is replaced
  // or cleared or the field unmounts, so a large image doesn't linger in memory
  // past the form that offered it. Derived from the selection, so the preview
  // comes back when the field remounts (after the "Cancel upload?" view).
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const picked = input.files?.[0];
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";

    if (!picked) return;

    const prepared = await prepareThumbnail(picked);
    if ("error" in prepared) {
      setError(prepared.error);
      return;
    }
    setError(null);
    onChange({ kind: "file", file: prepared.file });
  };

  const handleUseDefault = () => {
    setError(null);
    onChange({ kind: "default" });
  };

  const handleRemove = () => {
    onChange({ kind: "none" });
    setError(null);
  };

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-slate-400">Thumbnail (optional)</span>
      <div className="flex items-center gap-3">
        {previewUrl || value.kind === "default" ? (
          <div className="relative aspect-video w-32 shrink-0 overflow-hidden rounded-lg border border-slate-700 bg-[#11141c]">
            <img
              src={previewUrl ?? `/${DEFAULT_THUMBNAIL_PATH}`}
              alt="Thumbnail preview"
              className="size-full object-cover"
            />
            {value.kind === "default" ? (
              <span className="absolute left-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200">
                Default
              </span>
            ) : null}
            <button
              type="button"
              onClick={handleRemove}
              disabled={disabled}
              aria-label="Remove thumbnail"
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/70 text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-60"
            >
              <X size={12} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={disabled}
              className="flex aspect-video w-32 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-700 text-slate-400 transition-colors hover:border-slate-500 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ImagePlus size={18} />
              <span className="text-[11px] font-medium">Select image</span>
            </button>
            <button
              type="button"
              onClick={handleUseDefault}
              disabled={disabled}
              className="text-[11px] font-medium text-slate-400 underline-offset-2 transition-colors hover:text-slate-200 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            >
              Use default thumbnail
            </button>
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={THUMBNAIL_ACCEPT}
        className="hidden"
        onChange={handleSelect}
      />
    </div>
  );
}
