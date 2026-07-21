/**
 * Studio Director CLI — optional preflight for LessonScripts
 * (docs/lesson-script-authoring.md).
 *
 *   bun scripts/studio-director.ts                      # validate every script
 *   bun scripts/studio-director.ts src/studio/scripts/<slug>.yaml [...more]
 *
 * Validates schema, marker resolution, and dialog segmentation, runs the
 * advisory critic, and writes the critique sidecar next to each YAML. This is
 * a convenience for agents and CI — the production /studio route parses and
 * validates the YAML in the browser itself, so nothing here is required to
 * render a lesson.
 *
 * All pure logic lives in src/studio/** where it is type-checked and tested;
 * this file is the thin I/O shell.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { parseLessonScript } from "../src/studio/script/schema.ts";
import { extractNarration, requireMarker } from "../src/studio/script/markers.ts";
import { splitIntoDialogs } from "../src/studio/script/dialogs.ts";
import { critiqueScript, estimateNarrationDurationMs } from "../src/studio/script/critic.ts";
import { deckUrlsOf, resolveSlidesFromDecks } from "../src/studio/script/googleSlides.ts";
import { fetchPublishedDeck } from "../src/googleSlides/index.ts";
import type { ParsedDeck } from "../src/googleSlides/types.ts";
import { requireVoiceProfile } from "../src/studio/tts/profiles.ts";
import { sha256HexOfText } from "../src/studio/hash.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(repoRoot, "src", "studio", "scripts");

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

  // Marker resolution + dialog segmentation fail here, before any render.
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
  const estimatedDurationMs = estimateNarrationDurationMs(extracted.tokens.length);
  const critique = critiqueScript(script, extracted, estimatedDurationMs);
  for (const note of critique.notes) {
    console.log(`  ✎ [${note.severity}] ${note.message}`);
  }
  writeFileSync(
    scriptPath.replace(/\.ya?ml$/, ".critique.json"),
    `${JSON.stringify(critique, null, 2)}\n`,
  );

  // Published-deck slides: verify each referenced page exists. Network is
  // best-effort here (the render page re-fetches authoritatively) — an
  // unreachable deck is a warning, a missing page in a fetched deck an error.
  const deckUrls = deckUrlsOf(script.lesson.slides);
  if (deckUrls.length > 0) {
    const decks = new Map<string, ParsedDeck>();
    let fetched = true;
    for (const url of deckUrls) {
      try {
        decks.set(url, await fetchPublishedDeck(url));
      } catch (error) {
        fetched = false;
        console.warn(`  ⚠ published deck unreachable, page ids unverified: ${String(error)}`);
      }
    }
    if (fetched) {
      resolveSlidesFromDecks(script.lesson.slides, decks);
      console.log(`  ${deckUrls.length} published deck(s) fetched — every referenced page found`);
    }
  }

  console.log(
    `  ${extracted.tokens.length} tokens across ${dialogs.length} dialogs (${script.scenes.length} scenes); ~${Math.round(estimatedDurationMs / 1000)}s estimated`,
  );
  console.log(`  voice profile ${profile.id} (${profile.providerId}) — valid`);
}

const args = process.argv.slice(2);
// No arguments → validate every script, so agents and CI have one command.
const targets =
  args.length > 0
    ? args.map((arg) => resolve(arg))
    : readdirSync(scriptsDir)
        .filter((name) => name.endsWith(".yaml"))
        .sort()
        .map((name) => join(scriptsDir, name));

if (targets.length === 0) {
  fail(`no scripts found in ${scriptsDir}`);
}

for (const target of targets) {
  await directScript(target);
}
console.log("\nDone.");
