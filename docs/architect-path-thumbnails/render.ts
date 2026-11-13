// Renders every Architect Path course thumbnail from ../architect-path-thumbnail.html.
// Per-lesson data (title lines, notebook document, diagram) lives only in that page.
//
//   bun docs/architect-path-thumbnails/render.ts          # all 56
//   bun docs/architect-path-thumbnails/render.ts 3 18     # just lessons 3 and 18
//   bun docs/architect-path-thumbnails/render.ts --check  # check every card, write nothing
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const outDir = import.meta.dir;
const template = resolve(outDir, "../architect-path-thumbnail.html");
const scripts = resolve(outDir, "../../src/studio/scripts");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const only = new Set(args.filter((arg) => arg !== "--check").map(Number));

// The title a card shows is the lesson's own: the YAML is its one home.
function lessonTitle(slug: string): string {
  const yaml = readFileSync(join(scripts, `${slug}.yaml`), "utf8");
  const title = /^\s*title:\s*"?(.*?)"?\s*$/m.exec(yaml)?.[1];
  if (!title) throw new Error(`${slug}.yaml has no title`);
  return title;
}

const browser = await chromium.launch({ channel: "chrome" });
const failures: string[] = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(template).href);
  await page.evaluate(() => (window as any).thumbReady);

  const lessons: { number: number; slug: string; lines: string[] }[] = await page.evaluate(() =>
    (window as any).LESSONS.map((l: any) => ({ number: l.number, slug: l.slug, lines: l.lines })),
  );

  for (const lesson of lessons) {
    if (only.size > 0 && !only.has(lesson.number)) continue;
    const expected = `Architect Path ${String(lesson.number).padStart(2, "0")}: ${lesson.lines.join(" ")}`;
    if (lessonTitle(lesson.slug) !== expected)
      failures.push(
        `lesson ${lesson.number}: the card says "${expected}", the lesson is "${lessonTitle(lesson.slug)}"`,
      );

    const problems: string[] = await page.evaluate(async (n) => {
      const w = window as any;
      w.setThumb({ lesson: n });
      // A new glyph run can pull in a font face; wait for it, then refit.
      await document.fonts.ready;
      w.setThumb({ lesson: n });
      return w.glyphProblems();
    }, lesson.number);
    for (const problem of problems) failures.push(`lesson ${lesson.number}: ${problem}`);

    if (checkOnly) continue;
    const file = join(outDir, `${lesson.slug}.png`);
    await page.locator("#thumb").screenshot({ path: file });
    console.log(file);
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
