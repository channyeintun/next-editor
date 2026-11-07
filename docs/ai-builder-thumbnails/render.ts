// Renders every AI Builder course thumbnail from ../ai-builder-thumbnail.html.
// Per-lesson data lives only in that page's LESSONS array.
//
//   bun docs/ai-builder-thumbnails/render.ts          # all 32
//   bun docs/ai-builder-thumbnails/render.ts 3 18     # just lessons 3 and 18
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const outDir = import.meta.dir;
const template = resolve(outDir, "../ai-builder-thumbnail.html");
const only = new Set(process.argv.slice(2).map(Number));

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(template).href);
  await page.evaluate(() => (window as any).thumbReady);

  const lessons: { number: number; slug: string; code: string; bubble: string }[] =
    await page.evaluate(() =>
      (window as any).LESSONS.map((l: any) => ({
        number: l.number,
        slug: l.slug,
        code: l.code,
        bubble: l.bubble,
      })),
    );

  for (const lesson of lessons) {
    if (only.size > 0 && !only.has(lesson.number)) continue;
    // An empty document line or bubble renders as a blank card or a blank speech bubble.
    if (!lesson.code.trim() || !lesson.bubble.trim())
      throw new Error(`lesson ${lesson.number} has no document line or bubble in LESSONS`);
    await page.evaluate(async (n) => {
      const w = window as any;
      w.setThumb({ lesson: n });
      // A new glyph run can pull in a font face; wait for it, then refit.
      await document.fonts.ready;
      w.setThumb({ lesson: n });
    }, lesson.number);
    const file = join(outDir, `${lesson.slug}.png`);
    await page.locator("#thumb").screenshot({ path: file });
    console.log(file);
  }
} finally {
  await browser.close();
}
