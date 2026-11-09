// Renders the learning roadmap poster (the nine Burmese courses, in the order to take
// them) from learning-roadmap-poster.html, at 2× (2160×2700) so the small course
// descriptions stay sharp on a phone.
//
//   bun docs/learning-roadmap-poster-render.ts      # writes docs/learning-roadmap-poster.png
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const template = resolve(import.meta.dir, "learning-roadmap-poster.html");
const output = resolve(import.meta.dir, "learning-roadmap-poster.png");

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
