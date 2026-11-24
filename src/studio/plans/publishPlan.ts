import { validateNarrationLanguage, type StudioNarrationLanguage } from "../narrationLanguage";
import { encodePublishedScriptIndex, type PublishedScriptIndex } from "./publishedScripts";

/**
 * What a publish of the lesson scripts puts, decided from the index it would
 * write and the index that is live. Pure: the publisher
 * (scripts/lesson-scripts.ts) reads git and the bucket, and this says what to
 * do with what it read.
 *
 * The live index is the only record of what was published. Objects are named
 * by their bytes and never rewritten, so every object the live index names is
 * in the bucket; anything else is put, and the index last.
 */

/** A lesson the studio opens on when the URL names none, and the voice it opens with. */
export interface DefaultLesson {
  slug: string;
  language: StudioNarrationLanguage;
}

export interface LessonChanges {
  /** Slugs at the source that the live index does not name. */
  added: string[];
  /** Slugs whose script is not the one the live index names. */
  changed: string[];
  /** Slugs the live index names and the source does not have. */
  removed: string[];
}

export interface PublishPlan extends LessonChanges {
  /** Ids of the objects to put, in slug order, each once. */
  puts: string[];
  /** Whether the index itself must be put, after the objects. */
  putIndex: boolean;
  /** The index text to put. */
  indexText: string;
  /** Every reason not to publish. Nothing is put while there is one. */
  refusals: string[];
}

export interface PublishPlanInput {
  /** The index this publish would write. */
  next: PublishedScriptIndex;
  /** The live index and its stored text, or null when nothing was published yet. */
  live: { index: PublishedScriptIndex; text: string } | null;
  /** Whether a slug may leave the live index. */
  allowRemovals: boolean;
  /** The lessons the studio opens on: each must be there, in its voice's language. */
  defaultLessons: readonly DefaultLesson[];
}

/** The lessons that differ between a live index (or none) and the next one. */
export function lessonChanges(
  next: PublishedScriptIndex,
  live: PublishedScriptIndex | null,
): LessonChanges {
  // Own keys only: a slug such as `constructor` must not find an inherited member.
  const liveLessons = live?.lessons ?? {};
  const has = (lessons: object, slug: string) => Object.hasOwn(lessons, slug);
  const nextSlugs = Object.keys(next.lessons).sort();
  return {
    added: nextSlugs.filter((slug) => !has(liveLessons, slug)),
    changed: nextSlugs.filter(
      (slug) => has(liveLessons, slug) && liveLessons[slug].id !== next.lessons[slug].id,
    ),
    removed: Object.keys(liveLessons)
      .filter((slug) => !has(next.lessons, slug))
      .sort(),
  };
}

export function planPublish(input: PublishPlanInput): PublishPlan {
  const { next, live, allowRemovals, defaultLessons } = input;
  const changes = lessonChanges(next, live?.index ?? null);
  const refusals: string[] = [];

  if (changes.removed.length > 0 && !allowRemovals) {
    refusals.push(
      `${changes.removed.length} published lesson(s) would disappear: ${changes.removed.join(", ")} (--allow-removals removes them)`,
    );
  }
  for (const { slug, language } of defaultLessons) {
    const entry = next.lessons[slug];
    if (!entry) {
      refusals.push(`the studio opens on "${slug}" for ${language} narration, and it is missing`);
      continue;
    }
    const problem = validateNarrationLanguage(entry.locale, language);
    if (problem) {
      refusals.push(`the studio opens on "${slug}" for ${language} narration: ${problem}`);
    }
  }

  const published = new Set(live ? Object.values(live.index.lessons).map((entry) => entry.id) : []);
  const puts: string[] = [];
  for (const slug of Object.keys(next.lessons).sort()) {
    const { id } = next.lessons[slug];
    if (!published.has(id)) {
      published.add(id);
      puts.push(id);
    }
  }

  const indexText = encodePublishedScriptIndex(next);
  return {
    ...changes,
    puts,
    putIndex: live === null || live.text !== indexText,
    indexText,
    refusals,
  };
}
