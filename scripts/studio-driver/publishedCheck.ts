/**
 * Reads what checkScriptIds compares: the site's lesson index, and the id of
 * each local script file.
 */

import { existsSync, readFileSync } from "node:fs";
import { lessonScriptPath } from "../lessonScriptsDir.ts";
import { publishedScriptIdOf } from "../../src/studio/plans/publishedScriptEntry.ts";
import {
  parsePublishedScriptIndex,
  type PublishedScriptIndex,
} from "../../src/studio/plans/publishedScripts.ts";
import { DriverError } from "./browser.ts";
import { checkRenderedScripts, type RenderedScript, short } from "./scriptIds.ts";
import { isLoopbackUrl, publishedIndexUrl } from "./site.ts";
import { EVALUATE_TIMEOUT_MS } from "./waits.ts";

/** The local script's text, or null when this checkout has none. */
export function localScriptText(slug: string): string | null {
  const path = lessonScriptPath(slug);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The local script's id, computed as a publish names it. */
export async function localScriptId(slug: string): Promise<string | null> {
  const path = lessonScriptPath(slug);
  return existsSync(path) ? publishedScriptIdOf(readFileSync(path)) : null;
}

async function fetchIndex(site: string): Promise<PublishedScriptIndex> {
  const url = publishedIndexUrl(site);
  const response = await fetch(url, { signal: AbortSignal.timeout(EVALUATE_TIMEOUT_MS) });
  // A path the site does not route answers its HTML shell with a 200.
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("json")) {
    throw new Error(`${url} answered ${response.status} ${type || "with no content type"}`);
  }
  return parsePublishedScriptIndex(await response.json());
}

/**
 * Which script the site will render for each lesson. Refuses, with every
 * reason at once, when a site's script is not the local one and --published
 * does not say to render it anyway. A dev server on this machine that cannot
 * answer is only a warning: it renders the working tree.
 */
export async function resolveRenderedScripts(input: {
  site: string;
  slugs: readonly string[];
  published: boolean;
}): Promise<RenderedScript[]> {
  const loopback = isLoopbackUrl(input.site);
  let index: PublishedScriptIndex;
  try {
    index = await fetchIndex(input.site);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (loopback) {
      console.warn(
        `studio-render: warning: could not read the lesson index (${reason}); the script ids are not recorded`,
      );
      return [];
    }
    throw new DriverError(
      `could not read the site's lesson index, so cannot tell what it would render: ${reason}`,
    );
  }
  const localIds = new Map(
    await Promise.all(input.slugs.map(async (slug) => [slug, await localScriptId(slug)] as const)),
  );
  const check = checkRenderedScripts({
    slugs: input.slugs,
    index,
    localIds,
    loopback,
    published: input.published,
  });
  if ("refused" in check) {
    throw new DriverError(`not rendering:\n  ${check.refused.join("\n  ")}`);
  }
  for (const script of check.scripts) {
    const note =
      script.localId === script.id
        ? ""
        : script.localId
          ? " (not the local script)"
          : " (no local script)";
    console.log(`  ${script.slug}: script ${short(script.id)} from ${index.source}${note}`);
  }
  return check.scripts;
}
