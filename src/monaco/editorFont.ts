// Burmese in the code: Noto Sans Myanmar, the font Chrome on macOS falls back
// to for it. Its faces declare Unicode ranges, and Source Code Pro comes first,
// so the browser fetches only the Myanmar face, and only for Burmese text.
import "@fontsource/noto-sans-myanmar/400.css";
import "@fontsource/noto-sans-myanmar/700.css";
import codeRegularUrl from "source-code-pro/WOFF2/TTF/SourceCodePro-Regular.ttf.woff2?url";
import codeItalicUrl from "source-code-pro/WOFF2/TTF/SourceCodePro-It.ttf.woff2?url";
import codeBoldUrl from "source-code-pro/WOFF2/TTF/SourceCodePro-Bold.ttf.woff2?url";
import type { Monaco } from "./runtime";

// The editor's text grid is part of every recording: a pointer sample over the
// code is stored as a pixel offset from the editor's corner, so a viewer whose
// grid differs sees the pointer on another line or character. Lessons were
// recorded in Chrome on a Mac with Source Code Pro installed, so this
// reproduces that grid on every OS:
// - Both fonts ship with the app. Without them Windows draws Consolas (7.7px a
//   character, not 8.4px) and its own Myanmar font, whose clusters have other
//   widths. Source Code Pro is Adobe's complete font, not a Google subset:
//   Monaco keeps its fast monospace rendering only when "→" is as wide as "n",
//   and the subsets leave "→" out.
// - The line height is set rather than left to Monaco, whose default is
//   1.5 × fontSize on macOS but 1.35 × elsewhere (19px, not 21px).
// Columns still drift where the browser rounds glyph advances to whole pixels
// (Windows with font smoothing off, Linux with full hinting): 8px, not 8.4px.
const CODE_FONT = "Source Code Pro";
const MYANMAR_FONT = "Noto Sans Myanmar";
export const EDITOR_FONT_FAMILY = `"${CODE_FONT}", "${MYANMAR_FONT}"`;
export const EDITOR_FONT_SIZE = 14;
export const EDITOR_LINE_HEIGHT = 21;

// The styles the theme draws (code, italic comments, bold markdown), which are
// also the three Monaco measures.
const CODE_FACES: { url: string; descriptors: FontFaceDescriptors }[] = [
  { url: codeRegularUrl, descriptors: { weight: "400" } },
  { url: codeItalicUrl, descriptors: { weight: "400", style: "italic" } },
  { url: codeBoldUrl, descriptors: { weight: "700" } },
];

/**
 * Registers the editor's code font and loads it with the regular Burmese face,
 * then has Monaco measure again. Monaco measures the font once and caches the
 * result, so an editor created before the fonts arrived keeps the fallback's
 * widths for its gutter, caret and hit testing. One remeasure after every face
 * has settled replaces those with the real widths and redraws every line, the
 * Burmese ones included. A face that fails to load is measured as the fallback
 * the browser draws instead.
 */
export async function loadEditorFonts(monaco: Monaco): Promise<void> {
  if (typeof document === "undefined" || !document.fonts || typeof FontFace === "undefined") {
    return;
  }

  const fonts = document.fonts;
  const codeFaces = CODE_FACES.map(
    ({ url, descriptors }) =>
      new FontFace(CODE_FONT, `url(${url}) format("woff2")`, { display: "swap", ...descriptors }),
  );
  for (const face of codeFaces) fonts.add(face);

  await Promise.allSettled([
    ...codeFaces.map((face) => face.load()),
    fonts.load(`${EDITOR_FONT_SIZE}px "${MYANMAR_FONT}"`, "က"),
  ]);
  monaco.editor.remeasureFonts();
}
