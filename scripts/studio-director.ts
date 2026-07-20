/**
 * Studio Director CLI — the build-time half of the Director
 * (docs/agent-lesson-production.md §4/§6).
 *
 *   bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml [...more]
 *
 * Validates a LessonScript (schema, marker resolution, dialog segmentation),
 * runs the advisory critic, and emits the script JSON that the /studio route's
 * in-page Director consumes (src/studio/plans/scripts/<slug>.json). Narration
 * synthesis, dialog scheduling, and plan compilation happen in the page at
 * render time — pocket-tts over onnxruntime-web with a per-dialog
 * content-addressed cache — so this CLI needs no audio toolchain and runs on
 * any platform.
 *
 * All pure logic lives in src/studio/** where it is type-checked and tested;
 * this file is the thin I/O shell.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parseLessonScript } from "../src/studio/script/schema.ts";
import { extractNarration, requireMarker } from "../src/studio/script/markers.ts";
import { splitIntoDialogs } from "../src/studio/script/dialogs.ts";
import { critiqueScript } from "../src/studio/script/critic.ts";
import { requireVoiceProfile } from "../src/studio/tts/profiles.ts";
import { canonicalJson, sha256HexOfJson, sha256HexOfText } from "../src/studio/hash.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const emittedDir = join(repoRoot, "src", "studio", "plans", "scripts");

/** Pacing estimate for the critic before any audio exists (~140 spoken wpm). */
const ESTIMATED_WPM = 140;

function fail(message: string): never {
  console.error(`\nstudio-director: ${message}`);
  process.exit(1);
}

async function directScript(scriptPath: string): Promise<void> {
  const scriptSource = readFileSync(scriptPath, "utf8");
  const script = parseLessonScript(YAML.parse(scriptSource));
  const scriptHash = await sha256HexOfText(scriptSource);
  console.log(`\n▶ ${script.lesson.slug} (${scriptPath})`);
  console.log(`  script sha256 ${scriptHash.slice(0, 16)}…`);

  // Marker resolution + dialog segmentation fail here, before anything renders.
  const extracted = extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      if ("mark" in action.at) {
        requireMarker(extracted, action.at.mark);
      }
    }
  }
  const dialogs = splitIntoDialogs(extracted);
  const profile = requireVoiceProfile(script.build.voiceProfile);
  if (profile.providerId !== "pocket-tts-web") {
    console.warn(
      `  ⚠ profile "${profile.id}" is not in-page synthesizable; /studio will reject this script`,
    );
  }

  // Advisory critic (proposes notes; never blocks — §8). Duration estimated;
  // real pacing lands in the render report once audio exists.
  const estimatedDurationMs = Math.round((extracted.tokens.length / ESTIMATED_WPM) * 60_000);
  const critique = critiqueScript(script, extracted, estimatedDurationMs);
  for (const note of critique.notes) {
    console.log(`  ✎ [${note.severity}] ${note.message}`);
  }

  mkdirSync(emittedDir, { recursive: true });
  const scriptJson = `${JSON.stringify(JSON.parse(canonicalJson(script)), null, 2)}\n`;
  const scriptFile = join(emittedDir, `${script.lesson.slug}.json`);
  writeFileSync(scriptFile, scriptJson);
  writeFileSync(
    join(emittedDir, `${script.lesson.slug}.critique.json`),
    `${JSON.stringify(critique, null, 2)}\n`,
  );

  const emittedHash = await sha256HexOfJson(script);
  console.log(
    `  ${extracted.tokens.length} tokens across ${dialogs.length} dialogs (${script.scenes.length} scenes); ~${Math.round(estimatedDurationMs / 1000)}s estimated`,
  );
  console.log(`  voice profile ${profile.id} (${profile.providerId})`);
  console.log(`  emitted sha256 ${emittedHash.slice(0, 16)}… → ${scriptFile}`);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  fail("usage: bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml [...more]");
}

for (const arg of args) {
  await directScript(resolve(arg));
}
console.log("\nDone.");
