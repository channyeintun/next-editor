/**
 * Which lessons a studio workflow takes, in what order, with which thumbnail.
 * Course scripts are named `<course>-<NN>-<topic>` (css-course-01-basics,
 * sre-12-…) or `<language>-<topic>` (rust-borrow); thumbnails are exported
 * per course as `<NN>-<topic>.png` (docs/css-course-thumbnails/01-basics.png)
 * or `<NN>-<slug>.png` (docs/rust-from-zero-thumbnails/02-rust-variables.png).
 */

const NUMBERED_SLUG = /^(.*?)-(\d{2,})-/;
const NUMBER_PREFIX = /^(\d+)-/;

/** The course a lesson slug belongs to: its numbered prefix, else its first word. */
export function courseGroupOf(slug: string): string {
  return NUMBERED_SLUG.exec(slug)?.[1] ?? slug.split("-")[0] ?? slug;
}

export interface LessonGroup {
  name: string;
  slugs: string[];
}

/** Lessons grouped by course, groups and their lessons in name order. */
export function groupLessons(slugs: readonly string[]): LessonGroup[] {
  const groups = new Map<string, string[]>();
  for (const slug of [...slugs].sort()) {
    const name = courseGroupOf(slug);
    groups.set(name, [...(groups.get(name) ?? []), slug]);
  }
  return [...groups]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, members]) => ({
      name,
      slugs: members,
    }));
}

/** A file name without its extension, lowercased. */
function stemOf(fileName: string): string {
  const base = fileName.split("/").at(-1) ?? fileName;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase();
}

/**
 * The picked image that is this lesson's thumbnail, or null. A name that is
 * the slug, or ends it, matches — the longest such name, so `01-basics` beats
 * `basics` for css-course-01-basics; failing that, a name that is the slug
 * once its number is dropped (`02-rust-variables` for rust-variables). Two
 * images tied for the best match are no match, not a guess.
 */
export function matchThumbnail(slug: string, fileNames: readonly string[]): string | null {
  const key = slug.toLowerCase();
  const endings: string[] = [];
  const unnumbered: string[] = [];
  for (const name of fileNames) {
    const stem = stemOf(name);
    if (stem === key || key.endsWith(`-${stem}`)) {
      endings.push(name);
    } else if (stem.replace(NUMBER_PREFIX, "") === key) {
      unnumbered.push(name);
    }
  }
  if (endings.length > 0) {
    const longest = Math.max(...endings.map((name) => stemOf(name).length));
    const best = endings.filter((name) => stemOf(name).length === longest);
    return best.length === 1 ? best[0] : null;
  }
  return unnumbered.length === 1 ? unnumbered[0] : null;
}

/** A lesson's place in its course: the slug's number, else its thumbnail's. */
function courseNumberOf(slug: string, thumbnail: string | null): number | null {
  const fromSlug = NUMBERED_SLUG.exec(slug)?.[2];
  if (fromSlug) return Number(fromSlug);
  const fromThumbnail = thumbnail ? NUMBER_PREFIX.exec(stemOf(thumbnail))?.[1] : undefined;
  return fromThumbnail ? Number(fromThumbnail) : null;
}

/**
 * The order a workflow takes lessons in: course by course, each in its course
 * order — the number in its slug or, for courses whose slugs carry none (the
 * Rust course), in its thumbnail — and lessons with no number after the
 * numbered ones, by name.
 */
export function orderWorkflowLessons<T extends { slug: string; thumbnail: string | null }>(
  lessons: readonly T[],
): T[] {
  return [...lessons].sort((left, right) => {
    const byCourse = courseGroupOf(left.slug).localeCompare(courseGroupOf(right.slug));
    if (byCourse !== 0) return byCourse;
    const leftNumber = courseNumberOf(left.slug, left.thumbnail) ?? Number.POSITIVE_INFINITY;
    const rightNumber = courseNumberOf(right.slug, right.thumbnail) ?? Number.POSITIVE_INFINITY;
    if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    return left.slug.localeCompare(right.slug);
  });
}
