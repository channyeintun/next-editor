import { useRef, useState } from "react";
import { Captions, X } from "lucide-react";
import type { CaptionCue } from "@app/core/src";
import { MAX_CAPTION_BYTES } from "../../lessons/uploadLimits";
import { CAPTION_ACCEPT } from "./captionConstraints";

export interface SelectedCaption {
  /** Lowercase tag inferred from the filename (`subs.es.vtt` → "es"), "en" otherwise. */
  language: string;
  fileName: string;
  cues: CaptionCue[];
}

interface UploadCaptionsFieldProps {
  value: SelectedCaption[];
  onChange: (tracks: SelectedCaption[]) => void;
  disabled: boolean;
}

// The upload form's caption picker. The form owns the tracks it uploads; this
// owns reading and checking the files picked for them.
export default function UploadCaptionsField({
  value,
  onChange,
  disabled,
}: UploadCaptionsFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Applies the whole selection or none of it — a multi-file pick where one file
  // fails should not silently attach the rest.
  const handleSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const files = Array.from(input.files ?? []);
    // Clear the value so re-selecting the same file fires another change event.
    input.value = "";
    if (files.length === 0) return;

    // Every other failure in this handler reports through `error`; these
    // two awaits did not. The lazy chunk 404s after a deploy or offline, and the
    // blob read fails when the file moved or its volume unmounted between the
    // picker returning and the read — either one left the picker silently dead.
    let parseCaptions: typeof import("@app/captions/parseCaptions");
    try {
      parseCaptions = await import("@app/captions/parseCaptions");
    } catch {
      setError("Couldn't load the caption reader — check your connection and try again.");
      return;
    }

    const next = [...value];
    for (const file of files) {
      if (file.size > MAX_CAPTION_BYTES) {
        setError(`"${file.name}" is too large — 2MB max.`);
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        setError(`Couldn't read "${file.name}" — try selecting it again.`);
        return;
      }
      const cues = parseCaptions.detectAndParse(file.name, text);
      if (cues.length === 0) {
        setError(`No caption cues found in "${file.name}" — expected .vtt or .srt.`);
        return;
      }
      const language = parseCaptions.inferLanguageFromFilename(file.name) ?? "en";
      if (next.some((track) => track.language === language)) {
        setError(
          `A "${language}" track is already attached — name files like lesson.<lang>.vtt to set their language.`,
        );
        return;
      }
      next.push({ language, fileName: file.name, cues });
    }

    setError(null);
    onChange(next);
  };

  const handleRemove = (language: string) => {
    onChange(value.filter((track) => track.language !== language));
    setError(null);
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-slate-400">Captions (optional)</span>
      {value.length > 0 ? (
        <ul className="space-y-1">
          {value.map((track) => (
            <li
              key={track.language}
              className="flex items-center gap-2 rounded-lg border border-slate-700 bg-[#11141c] px-3 py-1.5"
            >
              <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-200">
                {track.language}
              </span>
              <span className="flex-1 truncate text-xs text-slate-300">{track.fileName}</span>
              <button
                type="button"
                onClick={() => handleRemove(track.language)}
                disabled={disabled}
                aria-label={`Remove ${track.language} captions`}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="flex items-center gap-2 text-[11px] font-medium text-slate-400 underline-offset-2 transition-colors hover:text-slate-200 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Captions size={14} aria-hidden="true" />
        Add caption file (.vtt / .srt)
      </button>
      {error ? (
        <p role="alert" className="text-xs text-rose-300">
          {error}
        </p>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept={CAPTION_ACCEPT}
        multiple
        className="hidden"
        onChange={handleSelect}
      />
    </div>
  );
}
