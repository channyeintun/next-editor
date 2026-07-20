/**
 * Studio Director CLI (docs/agent-lesson-production.md §4/§6, milestone M1).
 *
 *   bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml
 *
 * Validates a LessonScript, derives display/speech text (markers out, lexicon
 * applied to speech only), synthesizes narration once into the
 * content-addressed cache (macOS `say` + `afconvert`; cache hits skip
 * synthesis entirely), estimates token alignment, builds captions, compiles
 * the absolute-time StudioPlan, and writes it to
 * src/studio/plans/compiled/<slug>.json for the /studio registry.
 *
 * Runs under bun on the macOS workstation only (the one place `say` exists).
 * All pure logic lives in src/studio/** where it is type-checked and tested;
 * this file is the thin I/O shell.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parseLessonScript } from "../src/studio/script/schema.ts";
import { displayTextOf, extractNarration } from "../src/studio/script/markers.ts";
import { LEXICON_V1, speechTextOf } from "../src/studio/script/lexicon.ts";
import { estimateAlignment } from "../src/studio/script/alignment.ts";
import { compileLessonScript } from "../src/studio/script/compile.ts";
import {
  requireVoiceProfile,
  ttsRequestHash,
  type TtsCacheMeta,
} from "../src/studio/tts/profiles.ts";
import { canonicalJson, sha256Hex, sha256HexOfJson, sha256HexOfText } from "../src/studio/hash.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(repoRoot, "public", "studio-fixtures", "cache");
const compiledDir = join(repoRoot, "src", "studio", "plans", "compiled");

function fail(message: string): never {
  console.error(`\nstudio-director: ${message}`);
  process.exit(1);
}

function measureDurationMs(audioPath: string): number {
  const output = execFileSync("afinfo", [audioPath], { encoding: "utf8" });
  const match = output.match(/estimated duration:\s*([0-9.]+)\s*sec/);
  if (!match) {
    fail(`afinfo did not report a duration for ${audioPath}`);
  }
  return Math.round(Number.parseFloat(match[1]) * 1000);
}

function synthesize(speechText: string, voice: string, rateWpm: number, outPath: string): void {
  if (process.platform !== "darwin") {
    fail(
      "narration synthesis needs macOS (`say`); run the Director on the workstation or commit the cache from one",
    );
  }
  const tmpAiff = join(tmpdir(), `studio-narration-${Date.now()}.aiff`);
  try {
    execFileSync("say", ["-v", voice, "-r", String(rateWpm), "-o", tmpAiff, speechText]);
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", "-b", "64000", tmpAiff, outPath]);
  } finally {
    rmSync(tmpAiff, { force: true });
  }
}

async function directScript(scriptPath: string): Promise<void> {
  const scriptSource = readFileSync(scriptPath, "utf8");
  const script = parseLessonScript(YAML.parse(scriptSource));
  const scriptHash = await sha256HexOfText(scriptSource);
  console.log(`\n▶ ${script.lesson.slug} (${scriptPath})`);
  console.log(`  script sha256 ${scriptHash.slice(0, 16)}…`);

  // ---- Narration: display vs speech text ----------------------------------
  const extracted = extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
  const displayText = displayTextOf(extracted);
  const speechText = speechTextOf(extracted.tokens, LEXICON_V1);

  // ---- Synthesize once into the content-addressed cache -------------------
  const profile = requireVoiceProfile(script.build.voiceProfile);
  const requestHash = await ttsRequestHash({
    profile,
    speechText,
    lexiconVersion: LEXICON_V1.version,
  });
  mkdirSync(cacheDir, { recursive: true });
  const audioFile = join(cacheDir, `${requestHash}.m4a`);
  const metaFile = join(cacheDir, `${requestHash}.json`);

  let meta: TtsCacheMeta;
  if (existsSync(audioFile) && existsSync(metaFile)) {
    meta = JSON.parse(readFileSync(metaFile, "utf8")) as TtsCacheMeta;
    console.log(`  narration cache hit ${requestHash.slice(0, 16)}… (${meta.durationMs}ms)`);
  } else {
    console.log(`  synthesizing narration (${profile.providerId}, ${profile.voice})…`);
    synthesize(speechText, profile.voice, profile.rateWpm, audioFile);
    const audioBytes = readFileSync(audioFile);
    meta = {
      requestHash,
      profileId: profile.id,
      providerId: profile.providerId,
      voice: profile.voice,
      rateWpm: profile.rateWpm,
      mimeType: profile.mimeType,
      durationMs: measureDurationMs(audioFile),
      audioSha256: await sha256Hex(new Uint8Array(audioBytes)),
      speechText,
      lexiconVersion: LEXICON_V1.version,
      createdAtIso: new Date().toISOString(),
    };
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
    console.log(`  cached ${requestHash.slice(0, 16)}… (${meta.durationMs}ms)`);
  }

  // ---- Alignment + captions + compile -------------------------------------
  const alignment = estimateAlignment(extracted.tokens, meta.durationMs, LEXICON_V1);
  const { plan, warnings } = compileLessonScript({
    script,
    extracted,
    alignment,
    narration: {
      audioPath: `/studio-fixtures/cache/${requestHash}.m4a`,
      mimeType: profile.mimeType,
      durationMs: meta.durationMs,
    },
  });
  for (const warning of warnings) {
    console.warn(`  ⚠ ${warning}`);
  }

  // ---- Emit the compiled plan (stable key order → reproducible bytes) -----
  mkdirSync(compiledDir, { recursive: true });
  const planJson = `${JSON.stringify(JSON.parse(canonicalJson(plan)), null, 2)}\n`;
  const planFile = join(compiledDir, `${script.lesson.slug}.json`);
  writeFileSync(planFile, planJson);

  const planHash = await sha256HexOfJson(plan);
  console.log(
    `  display text: ${displayText.split(" ").length} tokens; audio ${meta.durationMs}ms`,
  );
  console.log(`  captions: ${plan.narration.captions.cues.length} cues`);
  console.log(`  actions: ${plan.actions.length} (incl. derived cursor moves)`);
  console.log(`  audio sha256 ${meta.audioSha256.slice(0, 16)}…`);
  console.log(`  plan sha256 ${planHash.slice(0, 16)}… → ${planFile}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  fail("usage: bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml [...more]");
}

for (const arg of args) {
  await directScript(resolve(arg));
}
console.log("\nDone.");
