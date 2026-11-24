import myanmarFaceUrl from "@fontsource/noto-sans-myanmar/files/noto-sans-myanmar-myanmar-400-normal.woff2?url";
import { FONT_FAMILY_NAMES } from "./whiteboardTextFit";

/**
 * The fonts the whiteboard draws with, all served by this app.
 *
 * Excalidraw draws text on a canvas in one of its own families, and left to
 * itself it gets two things from outside the app:
 *
 * - Its font files, which it fetches from esm.sh unless told where else they
 *   are. The build puts them on this origin (build/excalidrawFontsPlugin.ts)
 *   and `window.EXCALIDRAW_ASSET_PATH` points Excalidraw at them.
 * - Burmese. None of its families has Myanmar glyphs, so the browser drew them
 *   in whatever Myanmar font the viewer's system had: Noto Sans Myanmar on a
 *   Mac, and on other machines a font with other widths, or a poor one. A
 *   canvas only falls back to a system font, never to a web font the font
 *   string does not name, so the Noto Sans Myanmar the editor loads was not
 *   used. Each family therefore gets one more face here: that same file, for
 *   the Myanmar code points alone. The browser picks a family's face by code
 *   point, which is how Excalidraw itself adds Chinese to Excalifont, so
 *   Burmese now looks the same on every system and Latin text is untouched.
 *
 * The browser fetches the face the first time a family draws Burmese, and its
 * `loadingdone` then has Excalidraw redraw the text and the board refit it
 * (WhiteboardPanel).
 */

// Replaced by the build (excalidrawFontsPlugin); absent where nothing defines it.
declare const __EXCALIDRAW_ASSET_PATH__: string | undefined;

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}

// Helvetica is the one family Excalidraw takes from the viewer's system. A web
// face under a system font's name hides that font, so it would lose its Latin.
const SYSTEM_FONT_FAMILY = "Helvetica";

/** The families that get the Myanmar face: every one Excalidraw loads as a web font. */
export const MYANMAR_FACE_FAMILIES: readonly string[] = Object.values(FONT_FAMILY_NAMES).filter(
  (family) => family !== SYSTEM_FONT_FAMILY,
);

// The Myanmar blocks of the file's own range (@fontsource/noto-sans-myanmar).
// Its joiners and dotted circle are left out: they also appear in other text,
// which must not fetch this face or be drawn with it.
export const MYANMAR_UNICODE_RANGE = "U+1000-109F, U+A9E0-A9FE, U+AA60-AA7F";

let installed = false;

/**
 * Points Excalidraw at this app's copy of its fonts and adds the Myanmar face
 * to each family. Call it before the first canvas mounts: Excalidraw reads the
 * asset path when it first registers its fonts, and it loads a scene's fonts
 * from the faces the document has by then.
 */
export function installWhiteboardFonts(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  if (typeof __EXCALIDRAW_ASSET_PATH__ === "string") {
    window.EXCALIDRAW_ASSET_PATH = __EXCALIDRAW_ASSET_PATH__;
  }
  // jsdom has neither; a browser that old draws Burmese in its system font.
  if (typeof FontFace === "undefined" || !document.fonts) return;
  for (const family of MYANMAR_FACE_FAMILIES) {
    document.fonts.add(
      new FontFace(family, `url(${myanmarFaceUrl}) format("woff2")`, {
        unicodeRange: MYANMAR_UNICODE_RANGE,
        display: "swap",
      }),
    );
  }
}
