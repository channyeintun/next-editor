// Renders the CSS course announcement poster from css-course-poster.html.
//
//   bun docs/css-course-poster-render.ts      # writes docs/css-course-poster.png
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const template = resolve(import.meta.dir, "css-course-poster.html");
const output = resolve(import.meta.dir, "css-course-poster.png");

const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 1450 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(template).href);
  await page.evaluate(() => (window as unknown as { posterReady: Promise<unknown> }).posterReady);
  await page.locator("#poster").screenshot({ path: output });
  console.log(output);
} finally {
  await browser.close();
}
