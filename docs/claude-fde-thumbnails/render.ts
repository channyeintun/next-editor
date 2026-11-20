// Renders every Claude FDE course thumbnail from ../claude-fde-thumbnail.html.
// Per-lesson data (title lines, file line, drawing) lives only in that page.
//
//   bun docs/claude-fde-thumbnails/render.ts          # all 56
//   bun docs/claude-fde-thumbnails/render.ts 3 18     # just lessons 3 and 18
//   bun docs/claude-fde-thumbnails/render.ts --check  # check every card, write nothing
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { parse } from "yaml";
import { matchThumbnail } from "../../src/studio/workflow/workflowLessons";

const outDir = import.meta.dir;
const template = resolve(outDir, "../claude-fde-thumbnail.html");
const guide = resolve(outDir, "../claude-fde-course.md");
const scripts = resolve(outDir, "../../src/studio/scripts");
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const only = new Set(args.filter((arg) => arg !== "--check").map(Number));

interface Card {
  number: number;
  slug: string;
  lines: string[];
  file: string;
  line: string;
}

// A file line that was cut short ends in this.
const CUT = " …";

function walk(node: unknown, visit: (node: Record<string, any>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === "object") {
    visit(node as Record<string, any>);
    for (const value of Object.values(node)) walk(value, visit);
  }
}

// What a card says must be the lesson's own: its title, a file it works on, a line of that
// file, and (for a Burmese label in the drawing) a phrase the lesson shows. The YAML is the
// one home of all four.
function lessonProblems(card: Card, labels: string[]): string[] {
  const source = readFileSync(join(scripts, `${card.slug}.yaml`), "utf8");
  const script = parse(source);
  const lesson = script.lesson;
  const problems: string[] = [];

  const expected = `Claude FDE ${String(card.number).padStart(2, "0")}: ${card.lines.join(" ")}`;
  if (lesson.title !== expected)
    problems.push(`the card says "${expected}", the lesson is "${lesson.title}"`);

  const initial: string | undefined = lesson.workspace?.files?.[card.file];
  const fileLines = String(initial ?? "").split("\n");
  let typed = false;
  walk(script, (node) => {
    if (node.type !== "editor.type" || node.target?.file !== card.file) return;
    typed = true;
    fileLines.push(...String(node.text ?? "").split("\n"));
  });
  if (initial === undefined && !typed) problems.push(`the lesson has no file "${card.file}"`);

  const real = fileLines.map((line) => line.trim());
  const found = card.line.endsWith(CUT)
    ? real.some(
        (line) =>
          line.startsWith(card.line.slice(0, -CUT.length)) && line.length > card.line.length,
      )
    : real.includes(card.line);
  if (!found) problems.push(`"${card.line}" is not a line of ${card.file}`);

  for (const label of labels)
    if (!source.includes(label))
      problems.push(`the drawing's label "${label}" is not a phrase of the lesson`);
  return problems;
}

const failures: string[] = [];
const browser = await chromium.launch({ channel: "chrome" });
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
      lines: l.lines,
      file: l.file,
      line: l.line,
    })),
  );

  // One card for each lesson of the course, named so the studio workflow finds it.
  const slugs = readdirSync(scripts)
    .filter((name) => /^claude-fde-\d\d-.*\.yaml$/.test(name))
    .map((name) => name.replace(/\.yaml$/, ""));
  const names = cards.map((card) => `${card.slug}.png`);
  for (const slug of slugs)
    if (matchThumbnail(slug, names) !== `${slug}.png`) failures.push(`${slug} has no thumbnail`);
  for (const card of cards)
    if (!slugs.includes(card.slug)) failures.push(`${card.slug} is not a lesson`);

  // The part names are the course guide's.
  const partNames: string[] = await page.evaluate(() =>
    (window as any).PARTS.map((part: any) => part.name),
  );
  const guideParts = [...readFileSync(guide, "utf8").matchAll(/^### Part (\d+) · (.+)$/gm)];
  if (guideParts.length !== partNames.length)
    failures.push(`the guide has ${guideParts.length} parts, the page ${partNames.length}`);
  for (const [, number, name] of guideParts)
    if (partNames[Number(number) - 1] !== name)
      failures.push(
        `part ${number} is "${partNames[Number(number) - 1]}", the guide says "${name}"`,
      );

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

    if (checkOnly) continue;
    const file = join(outDir, `${card.slug}.png`);
    await page.locator("#thumb").screenshot({ path: file });
    console.log(file);
  }

  // A PNG left over from a renamed lesson would be picked up as a second match.
  for (const name of readdirSync(outDir))
    if (name.endsWith(".png") && !names.includes(name)) failures.push(`${name} has no card`);
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
if (checkOnly) console.log(`${only.size || 56} cards checked`);
