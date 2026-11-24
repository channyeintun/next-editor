/**
 * Which version of a lesson a render performs. The studio reads each script
 * from the site's lesson index, never from this checkout, so a script edited
 * here and not published would be rendered (and uploaded, and published) in
 * its old form while the person thinks it is the fix. Before a render against
 * a site, the driver compares the local file's id with the one the site
 * publishes and refuses on a difference unless told to render what is
 * published.
 */

import type { PublishedScriptIndex } from "../../src/studio/plans/publishedScripts.ts";

export interface RenderedScript {
  slug: string;
  /** The id of the script the site serves for the lesson: what is rendered. */
  id: string;
  /** What the site's index was built from: a commit, or the dev server's working tree. */
  source: string;
  /** The local file's id; null when this checkout has no such script. */
  localId: string | null;
}

export type ScriptCheck = { scripts: RenderedScript[] } | { refused: string[] };

/** What a person runs to put committed lessons on the site. */
export const PUBLISH_COMMAND = "bun scripts/lesson-scripts.ts publish --remote";

/**
 * Compare the lessons a command will render with what the site publishes.
 *
 * `loopback` is a dev server on this machine, which serves the working tree
 * itself, so a difference there is not refused (it can only mean another
 * LESSONS_DIR). `published` is the person saying to render what the site has.
 * A lesson the site does not list is refused either way: the studio could not
 * render it.
 */
export function checkRenderedScripts(input: {
  slugs: readonly string[];
  index: PublishedScriptIndex;
  localIds: ReadonlyMap<string, string | null>;
  loopback: boolean;
  published: boolean;
}): ScriptCheck {
  const refused: string[] = [];
  const scripts: RenderedScript[] = [];
  for (const slug of input.slugs) {
    const entry = input.index.lessons[slug];
    const localId = input.localIds.get(slug) ?? null;
    if (!entry) {
      refused.push(`${slug}: the site's lesson index does not list it`);
      continue;
    }
    if (!input.loopback && !input.published && localId !== entry.id) {
      refused.push(
        localId === null
          ? `${slug}: this checkout has no script for it; pass --published to render the site's version (${short(entry.id)})`
          : `${slug}: the local script (${short(localId)}) is not the published one (${short(entry.id)}); commit and push it, then publish first with "${PUBLISH_COMMAND}", or pass --published to render the published one`,
      );
      continue;
    }
    scripts.push({ slug, id: entry.id, source: input.index.source, localId });
  }
  return refused.length ? { refused } : { scripts };
}

/** An id short enough to read in a line, long enough to tell two apart. */
export function short(id: string): string {
  return id.slice(0, 12);
}
