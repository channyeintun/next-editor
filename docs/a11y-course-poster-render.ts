// Renders the Accessibility course announcement poster from a11y-course-poster.html,
// at 2× (2160×2700) so the small lesson thumbnails in its grid stay sharp.
//
//   bun docs/a11y-course-poster-render.ts      # writes docs/a11y-course-poster.png
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const template = resolve(import.meta.dir, "a11y-course-poster.html");
const output = resolve(import.meta.dir, "a11y-course-poster.png");

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1450 },
    deviceScaleFactor: 2,
  });
  await page.goto(pathToFileURL(template).href);
  await page.evaluate(() => (window as unknown as { posterReady: Promise<unknown> }).posterReady);
  await page.locator("#poster").screenshot({ path: output });
  console.log(output);
} finally {
  await browser.close();
}
