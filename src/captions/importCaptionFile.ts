import type { CaptionCue } from "../core/src/types";

export type ParsedCaptionFile = { cues: CaptionCue[]; language: string } | { error: string };

/**
 * A picked caption file's cues and language, or what to tell the viewer when it gives none.
 * The parser loads on demand, so the player pays for it only when a file is picked; and since
 * the React Compiler cannot compile a function holding `import()`, the picker's hook
 * (components/mediaControls/useCaptionFileImport.ts) calls this rather than holding it.
 */
export async function parseCaptionFile(file: File): Promise<ParsedCaptionFile> {
  // The parser yields zero cues for any file whose timestamp lines miss its
  // format — timestamps with no fractional part, a non-subtitle file picked
  // past the accept filter, a UTF-16 file that decodes as mojibake. A bare
  // return there meant "Import captions…" appeared to do nothing at all.
  let parseCaptions: typeof import("./parseCaptions");
  let text: string;
  try {
    parseCaptions = await import("./parseCaptions");
    text = await file.text();
  } catch {
    return { error: `Couldn't read "${file.name}" — try selecting it again.` };
  }

  const { detectAndParse, inferLanguageFromFilename } = parseCaptions;
  const cues = detectAndParse(file.name, text);
  if (cues.length === 0) {
    return { error: `No captions found in "${file.name}" — expected WebVTT or SRT.` };
  }

  return { cues, language: inferLanguageFromFilename(file.name) ?? "en" };
}
