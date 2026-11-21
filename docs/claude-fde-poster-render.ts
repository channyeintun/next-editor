// Renders the Claude FDE course announcement poster from claude-fde-poster.html,
// at 2× (2160×2700) so the badge's small print stays sharp in a feed.
//
//   bun docs/claude-fde-poster-render.ts      # writes docs/claude-fde-poster.png
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const template = resolve(import.meta.dir, "claude-fde-poster.html");
const output = resolve(import.meta.dir, "claude-fde-poster.png");

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
