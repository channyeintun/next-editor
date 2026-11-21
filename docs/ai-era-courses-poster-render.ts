// Renders the five-course poster (Learn AI, AI Builder Course, Claude FDE, Site
// Reliability Engineering, Architect Path) from ai-era-courses-poster.html, at 2×
// (2160×2700) so the course cards' small print stays sharp in a feed.
//
//   bun docs/ai-era-courses-poster-render.ts      # writes docs/ai-era-courses-poster.png
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const template = resolve(import.meta.dir, "ai-era-courses-poster.html");
const output = resolve(import.meta.dir, "ai-era-courses-poster.png");

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
