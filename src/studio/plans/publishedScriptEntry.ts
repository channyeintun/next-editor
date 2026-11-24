import { sha256Hex } from "../../shared/sha256Hex";
import { defaultRuntimeModeOf } from "../plan";
import { parseLessonScriptYaml } from "../script/parseYaml";
import type { LessonScript } from "../script/schema";
import type { PublishedScriptEntry } from "./publishedScripts";

/**
 * How a lesson script's file becomes its entry in the lesson index. The
 * publisher (scripts/lesson-scripts.ts) and the dev server's index
 * (build/lessonScriptsDevPlugin.ts) both build entries here, so the two
 * indexes cannot disagree about what an entry holds.
 *
 * Node-safe: no fetch, no DOM. It parses with the studio's own schema, so a
 * script that this studio cannot read never gets an entry.
 */

export interface PublishedScriptFile {
  entry: PublishedScriptEntry;
  script: LessonScript;
}

// Fatal: a file that is not UTF-8 would be read as something other than its
// bytes, and the id names the bytes.
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The entry for one script's YAML bytes. Throws when the bytes are not a LessonScript. */
export async function publishedScriptFileOf(bytes: Uint8Array): Promise<PublishedScriptFile> {
  const script = parseLessonScriptYaml(utf8.decode(bytes));
  return {
    entry: {
      id: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      title: script.lesson.title,
      locale: script.lesson.locale,
      runtimeMode: defaultRuntimeModeOf(script.runtime),
    },
    script,
  };
}

/** The slug a script file name gives, or null when the name is not `<slug>.yaml`. */
export function lessonSlugOfFileName(fileName: string): string | null {
  return fileName.endsWith(".yaml") && fileName.length > ".yaml".length
    ? fileName.slice(0, -".yaml".length)
    : null;
}

/**
 * Why a script's file name does not fit the script, or null when it does. The
 * studio finds a lesson by its file name and the script names itself in
 * `lesson.slug`; the two must be one name.
 */
export function lessonFileNameProblem(fileName: string, lessonSlug: string): string | null {
  const slug = lessonSlugOfFileName(fileName);
  if (slug === null) return `${fileName} is not named <slug>.yaml`;
  return slug === lessonSlug
    ? null
    : `${fileName} holds lesson.slug "${lessonSlug}"; the file must be ${lessonSlug}.yaml`;
}
