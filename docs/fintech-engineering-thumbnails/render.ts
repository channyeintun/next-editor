// Renders every Fintech Engineering course thumbnail from ../fintech-engineering-thumbnail.html.
// Per-lesson data (title lines, real line, diagram) lives only in that page.
//
//   bun docs/fintech-engineering-thumbnails/render.ts          # all 40
//   bun docs/fintech-engineering-thumbnails/render.ts 3 18     # just lessons 3 and 18
//   bun docs/fintech-engineering-thumbnails/render.ts --check  # check every card, write nothing
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { parse } from "yaml";
import { matchThumbnail } from "../../src/studio/workflow/workflowLessons";
import { lessonScriptPath, lessonScriptSlugs } from "../../scripts/lessonScriptsDir";

const outDir = import.meta.dir;
const template = resolve(outDir, "../fintech-engineering-thumbnail.html");
const guide = resolve(outDir, "../fintech-engineering-course.md");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const only = new Set(args.filter((arg) => arg !== "--check").map(Number));

const SLUG_PREFIX = "fintech-";

interface Card {
  number: number;
  slug: string;
  part: number;
  lines: string[];
  real: string;
}

// The studio workflow pairs a lesson with the PNG named after the end of its slug.
const fileOf = (slug: string) => `${slug.slice(SLUG_PREFIX.length)}.png`;

// Text as a reader sees it: entities and YAML escapes undone, runs of space collapsed, no case.
const plain = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase();

function strings(node: unknown, out: string[]): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const item of node) strings(item, out);
  else if (node && typeof node === "object")
    for (const value of Object.values(node)) strings(value, out);
  return out;
}

// What a card says must be the lesson's own: its title, its real line, and every word and
// number in its diagram. The YAML is the one home of all three (its code, its pinned program
// output, and the text of its figures).
function lessonProblems(card: Card, labels: string[]): string[] {
  const source = readFileSync(lessonScriptPath(card.slug), "utf8");
  const script = parse(source);
  const problems: string[] = [];

  const expected = `Fintech Engineering ${String(card.number).padStart(2, "0")}: ${card.lines.join(" ")}`;
  if (script.lesson.title !== expected)
    problems.push(`the card says "${expected}", the lesson is "${script.lesson.title}"`);

  const text = plain(`${source}\n${strings(script, []).join("\n")}`);
  if (!text.includes(plain(card.real)))
    problems.push(`the real line "${card.real}" is not a line of the lesson`);
  for (const label of new Set(labels))
    if (!text.includes(plain(label)))
      problems.push(`the diagram's label "${label}" is not in the lesson`);
  return problems;
}

const failures: string[] = [];
const browser = await chromium.launch({ channel: "chrome" });
let checked = 0;
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(template).href);
  await page.evaluate(() => (window as any).thumbReady);

  const cards: Card[] = await page.evaluate(() =>
    (window as any).LESSONS.map((l: any) => ({
      number: l.number,
      slug: l.slug,
      part: l.part,
      lines: l.lines,
      real: l.real,
    })),
  );

  // One card for each lesson of the course, named so the studio workflow finds it.
  const slugs = lessonScriptSlugs().filter((slug) => /^fintech-\d\d-/.test(slug));
  const names = cards.map((card) => fileOf(card.slug));
  for (const slug of slugs)
    if (matchThumbnail(slug, names) !== fileOf(slug)) failures.push(`${slug} has no thumbnail`);
  for (const card of cards)
    if (!slugs.includes(card.slug)) failures.push(`${card.slug} is not a lesson`);

  // The parts, and the part each lesson is in, are the course guide's.
  const partNames: string[] = await page.evaluate(() =>
    (window as any).PARTS.map((part: any) => part.name),
  );
  const guideParts = readFileSync(guide, "utf8")
    .split(/^### Part /m)
    .slice(1);
  if (guideParts.length !== partNames.length)
    failures.push(`the guide has ${guideParts.length} parts, the page ${partNames.length}`);
  guideParts.forEach((section, i) => {
    const name = /^\d+ · (.+)$/m.exec(section)?.[1];
    if (partNames[i] !== name)
      failures.push(`part ${i + 1} is "${partNames[i]}", the guide says "${name}"`);
    for (const [, slug] of section.split(/^## /m)[0].matchAll(/`(fintech-\d\d-[a-z0-9-]+)`/g)) {
      const card = cards.find((entry) => entry.slug === slug);
      if (card && card.part !== i + 1)
        failures.push(`${slug} is in part ${card.part} on the page, part ${i + 1} in the guide`);
    }
  });

  for (const card of cards) {
    if (only.size > 0 && !only.has(card.number)) continue;
    const { problems, labels }: { problems: string[]; labels: string[] } = await page.evaluate(
      async (n) => {
        const w = window as any;
        w.setThumb({ lesson: n });
        // A new glyph run can pull in a font face; wait for it, then refit.
        await document.fonts.ready;
        w.setThumb({ lesson: n });
        return { problems: w.cardProblems(), labels: w.cardLabels() };
      },
      card.number,
    );
    if (slugs.includes(card.slug)) problems.push(...lessonProblems(card, labels));
    for (const problem of problems) failures.push(`lesson ${card.number}: ${problem}`);
    checked += 1;

    if (checkOnly) continue;
    const file = join(outDir, fileOf(card.slug));
    await page.locator("#thumb").screenshot({ path: file });
    console.log(file);
  }

  // A lesson with no PNG has no thumbnail; a PNG left over from a renamed lesson would be
  // picked up as a second match.
  const onDisk = readdirSync(outDir).filter((name) => name.endsWith(".png"));
  for (const name of names) if (!onDisk.includes(name)) failures.push(`${name} is not rendered`);
  for (const name of onDisk) if (!names.includes(name)) failures.push(`${name} has no card`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
if (checkOnly) console.log(`${checked} cards checked`);
