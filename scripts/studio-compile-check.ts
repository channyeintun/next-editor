/**
 * Studio compile check — offline schedule, narration and whiteboard checks
 * for LessonScripts (docs/lesson-script-authoring.md "Workflow").
 *
 *   bun scripts/studio-compile-check.ts src/studio/scripts/<slug>.yaml [...more]
 *                                       [--rates=55,70,95] [--json=<out.json>]
 *
 * The registry test (src/studio/plans/index.test.ts) compiles every script
 * against dialog lengths estimated from whitespace tokens, which badly
 * underestimates Burmese: it puts few spaces between words. This compiles
 * each script at several rates estimated by characters instead — 55, 70 and
 * 95 ms per character by default, a fast, a typical (VoxCPM2 Burmese speaks
 * ~14 characters a second) and a slow narrator — so a timeline that only
 * breaks with real audio fails here, before any synthesis is paid for. It
 * also runs the narration and whiteboard checks the schema cannot express.
 *
 * Exits 1 when any script has an error: a schedule or compile failure at any
 * rate, a Burmese dialog over the VoxCPM2 request limit, a pale whiteboard
 * colour, or a label under 28px. Warnings are advisory — fix each one, or
 * keep it on purpose.
 *
 * All pure logic lives in src/studio/** where it is type-checked and tested
 * (script/estimatedCompile.ts, script/narrationLint.ts,
 * whiteboardLegibility.ts); this file is the thin I/O shell.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import {
  compileWithEstimatedNarration,
  estimateByCharacters,
  narrationOf,
} from "../src/studio/script/estimatedCompile.ts";
import { narrationIssues } from "../src/studio/script/narrationLint.ts";
import { parseLessonScript } from "../src/studio/script/schema.ts";
import {
  WHITEBOARD_MIN_LABEL_PX,
  WHITEBOARD_VISIBLE_AREA,
  whiteboardInkProblems,
  whiteboardLabelProblems,
} from "../src/studio/whiteboardLegibility.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface RateResult {
  msPerChar: number;
  totalMs: number;
  warnings: string[];
  error?: string;
}

interface CheckResult {
  file: string;
  slug: string;
  rates: RateResult[];
  warnings: string[];
  errors: string[];
}

function usage(message: string): never {
  console.error(`studio-compile-check: ${message}
usage: bun scripts/studio-compile-check.ts <lesson.yaml> [...more] [--rates=55,70,95] [--json=<out.json>]`);
  process.exit(2);
}

function parseArgs(argv: string[]): { files: string[]; rates: number[]; json: string | null } {
  const files: string[] = [];
  let rates = [55, 70, 95];
  let json: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--rates=")) {
      rates = arg.slice("--rates=".length).split(",").map(Number);
      if (rates.length === 0 || rates.some((rate) => !(rate > 0))) {
        usage(`--rates takes positive ms-per-character numbers, got "${arg}"`);
      }
    } else if (arg.startsWith("--json=")) {
      json = resolve(arg.slice("--json=".length));
    } else if (arg.startsWith("--")) {
      usage(`unknown flag ${arg}`);
    } else {
      files.push(resolve(arg));
    }
  }
  if (files.length === 0) usage("name at least one lesson YAML");
  return { files, rates, json };
}

function displayPath(file: string): string {
  return file.startsWith(`${repoRoot}/`) ? relative(repoRoot, file) : file;
}

function checkScript(file: string, rates: number[]): CheckResult {
  const script = parseLessonScript(YAML.parse(readFileSync(file, "utf8")));
  const narration = narrationOf(script);
  const result: CheckResult = {
    file: displayPath(file),
    slug: script.lesson.slug,
    rates: [],
    warnings: [],
    errors: [],
  };

  // The plan validates its own timeline (overlaps, narration end), so a rate
  // that does not fit throws here exactly as it would at render.
  for (const msPerChar of rates) {
    try {
      const { schedule, warnings } = compileWithEstimatedNarration(
        script,
        estimateByCharacters(msPerChar),
        narration,
      );
      result.rates.push({ msPerChar, totalMs: schedule.totalDurationMs, warnings });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.rates.push({ msPerChar, totalMs: 0, warnings: [], error: message });
      result.errors.push(`@${msPerChar} ms/char: ${message}`);
    }
  }

  for (const issue of narrationIssues(script.lesson.locale, narration)) {
    const line = `dialog ${issue.dialogId} ${issue.message}`;
    (issue.severity === "error" ? result.errors : result.warnings).push(line);
  }

  const labels = whiteboardLabelProblems(script);
  for (const label of labels.tooSmall) {
    result.errors.push(
      `whiteboard ${label} is under the ${WHITEBOARD_MIN_LABEL_PX}px readable floor (titles ≥ 36px)`,
    );
  }
  const { left, top, right, bottom } = WHITEBOARD_VISIBLE_AREA;
  for (const id of labels.offCanvas) {
    result.warnings.push(
      `whiteboard ${id} leaves the visible area (${left},${top})–(${right},${bottom})`,
    );
  }
  const ink = whiteboardInkProblems(script);
  for (const asset of ink.pale) {
    result.errors.push(
      `whiteboard ${asset} is pale and inverts to near-black on the dark board — use #1e1e1e or the mid-tone palette`,
    );
  }
  if (ink.oneShapeColour) {
    result.warnings.push(
      "whiteboard shapes use one colour — give colour a job with the mid-tone palette",
    );
  }

  const characters = narration.speechTexts.reduce((total, text) => total + text.length, 0);
  console.log(`\n▶ ${result.slug} (${result.file})`);
  console.log(
    `  ${script.scenes.length} scenes, ${narration.dialogs.length} dialogs, ${characters} narration characters`,
  );
  for (const rate of result.rates) {
    const label = `@${rate.msPerChar} ms/char`;
    if (rate.error) {
      console.log(`  ✗ ${label}: ${rate.error}`);
      continue;
    }
    const count = rate.warnings.length > 0 ? `, ${rate.warnings.length} warning(s)` : "";
    console.log(`  ${label}: ${(rate.totalMs / 60_000).toFixed(1)} min${count}`);
    for (const warning of rate.warnings) console.log(`      ⚠ ${warning}`);
  }
  for (const warning of result.warnings) console.log(`  ⚠ ${warning}`);
  for (const error of result.errors) console.log(`  ✗ ${error}`);
  const warningCount = result.warnings.length + result.rates.flatMap((r) => r.warnings).length;
  console.log(
    result.errors.length > 0
      ? `  ✗ FAIL: ${result.errors.length} error(s), ${warningCount} warning(s)`
      : `  ✓ PASS: ${warningCount} warning(s)`,
  );
  return result;
}

const { files, rates, json } = parseArgs(process.argv.slice(2));

// One bad script must not hide the state of the rest: report each, keep
// going, and fail the run at the end.
const results: CheckResult[] = [];
let failed = 0;
for (const file of files) {
  try {
    const result = checkScript(file, rates);
    results.push(result);
    if (result.errors.length > 0) failed += 1;
  } catch (error) {
    console.error(
      `\n✗ ${displayPath(file)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    failed += 1;
  }
}

if (json) writeFileSync(json, `${JSON.stringify(results, null, 2)}\n`);
console.log(`\n${files.length - failed} of ${files.length} script(s) pass.`);
if (failed > 0) {
  console.error(`\nstudio-compile-check: ${failed} script(s) failed`);
  process.exit(1);
}
