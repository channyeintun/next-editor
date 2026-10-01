import type { ExtractedNarration } from "./markers";
import type { LessonScript } from "./schema";

/**
 * Advisory script critic (docs/agent-lesson-production.md §8/§12 M4): purely
 * mechanical lint notes against the versioned persona guide
 * (docs/studio-persona.md). Advisory by construction — the critic can propose
 * structured notes but has no blocking power and no approve verdict; a human
 * remains the editorial gate. Lints against the persona guide version below.
 */

/**
 * Version of the critic's output. Bumped whenever a rule is added, removed, or
 * changes what it reports, so a checked-in sidecar shows which rules wrote it.
 */
export const CRITIC_VERSION = 3;

/** The docs/studio-persona.md version the notes cite. */
export const PERSONA_GUIDE_VERSION = 2;

export type CritiqueSeverity = "note" | "suggestion";

export interface CritiqueNote {
  id: string;
  severity: CritiqueSeverity;
  sceneId?: string;
  message: string;
}

export interface ScriptCritique {
  version: number;
  notes: CritiqueNote[];
}

/** Persona guide v1 banned-filler list (docs/studio-persona.md). */
export const BANNED_PHRASES_V1 = [
  "just simply",
  "simply",
  "obviously",
  "of course",
  "easy",
  "easily",
  "as we all know",
  "needless to say",
  "delve",
  "in this video",
  "don't worry",
];

/**
 * Read-aloud fingerprints (persona guide v2 "Conversational, not read-aloud"):
 * forms a speaker would contract. The value is the suggested contraction.
 *
 * This note is mandatory-fix, so it must not fire on prose that is already
 * correct — an author (or an agent) told to fix every one would otherwise write
 * something wrong. Two rules keep it sound:
 *
 * - "you have" / "we have" are deliberately absent. "you have three files" and
 *   "we have to name the owner" are ordinary English; "you've three files" is
 *   archaic and "we've to name" is simply wrong.
 * - every form here is matched mid-clause only (see READ_ALOUD_SUFFIX). A form
 *   that ends a clause cannot contract — "leave it as it is", "yes we will" —
 *   while the same words mid-clause can: "it is faster", "we will look".
 *
 * The cost is a few missed clause-final negations ("No, I have not."), which is
 * the right trade for a check whose notes are meant to be applied unconditionally.
 */
export const UNCONTRACTED_FORMS: Record<string, string> = {
  "it is": "it's",
  "that is": "that's",
  "there is": "there's",
  "here is": "here's",
  "what is": "what's",
  "let us": "let's",
  "do not": "don't",
  "does not": "doesn't",
  "did not": "didn't",
  "is not": "isn't",
  "are not": "aren't",
  "was not": "wasn't",
  "were not": "weren't",
  cannot: "can't",
  "will not": "won't",
  "would not": "wouldn't",
  "could not": "couldn't",
  "should not": "shouldn't",
  "have not": "haven't",
  "has not": "hasn't",
  "you are": "you're",
  "we are": "we're",
  "they are": "they're",
  "you will": "you'll",
  "we will": "we'll",
};

/**
 * Requires a following word on the same clause, so only contractible positions
 * match. A comma or full stop right after the form fails this — which is exactly
 * where the contraction would be wrong.
 */
const READ_ALOUD_SUFFIX = "(?=\\s+[a-z0-9])";

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function critiqueScript(
  script: LessonScript,
  extracted: ExtractedNarration,
): ScriptCritique {
  const notes: CritiqueNote[] = [];

  // No pacing band. The critic runs before any audio exists, so its only
  // duration was the token count over a fixed words-per-minute rate, and the
  // rate it then measured was always that same constant — the check could never
  // fire. Pacing can only be judged from the synthesized narration.

  // No scope limits. Scene count and narration length are shape, not defects: a
  // survey lesson that tours a whole language legitimately runs to fourteen
  // scenes and several minutes, and flagging that taught nothing while making
  // every crash course look broken. What remains below lints narration quality —
  // banned filler, register, missing sources — none of which penalize a lesson
  // for covering a lot.

  for (const scene of script.scenes) {
    const sceneTokens =
      extracted.scenes.find((candidate) => candidate.sceneId === scene.id)?.tokens ?? [];
    const displayText = sceneTokens.join(" ");
    const lowered = displayText.toLowerCase();

    // Banned filler. Longest phrases first so "just simply" wins over "simply",
    // and each match is blanked out so the shorter phrase inside it is not also
    // reported. Every distinct phrase in the scene gets its own note — reporting
    // one at a time would make an author fix, re-run, and find the next.
    let unreported = lowered;
    for (const phrase of [...BANNED_PHRASES_V1].sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(`\\b${escapeForRegExp(phrase)}\\b`, "gi");
      const stripped = unreported.replace(pattern, " ");
      if (stripped === unreported) {
        continue;
      }
      unreported = stripped;
      notes.push({
        id: `phrase.${phrase.replace(/\s+/g, "-")}`,
        severity: "note",
        sceneId: scene.id,
        message: `Banned phrase "${phrase}" in scene "${scene.id}" (persona guide v${PERSONA_GUIDE_VERSION})`,
      });
    }

    // Conversational register: the narrator always talks, never reads.
    // Uncontracted forms are the reliable fingerprint of read-aloud prose.
    const readAloud: string[] = [];
    for (const [form, contraction] of Object.entries(UNCONTRACTED_FORMS)) {
      if (new RegExp(`\\b${escapeForRegExp(form)}\\b${READ_ALOUD_SUFFIX}`, "i").test(lowered)) {
        readAloud.push(`"${form}" → "${contraction}"`);
      }
    }
    if (readAloud.length > 0) {
      notes.push({
        id: "register.read-aloud",
        severity: "note",
        sceneId: scene.id,
        message: `Scene "${scene.id}" reads instead of talks — contract: ${readAloud.join(", ")} (persona guide v${PERSONA_GUIDE_VERSION})`,
      });
    }

    // No sentence-length ceiling either — a word count says nothing about
    // whether a sentence is clear.

    // Claim sourcing.
    if (scene.sources.length === 0) {
      notes.push({
        id: "sources.missing",
        severity: "note",
        sceneId: scene.id,
        message: `Scene "${scene.id}" cites no sources — the persona guide requires claim sourcing`,
      });
    }
  }

  // Marker hygiene. A mark no action anchors to is still a dialog split, and
  // every split buys a breath between dialogs, so authors place them on purpose
  // (an action anchored to a missing mark is a compile error elsewhere). Only a
  // mark that splits nothing is a leftover: one at the start or end of its
  // scene, or at the same word as a mark already splitting there — dialogs
  // split at the same positions with or without it.
  const referencedMarks = new Set<string>();
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      if ("mark" in action.at) {
        referencedMarks.add(action.at.mark);
      }
    }
  }
  for (const scene of extracted.scenes) {
    const sceneEnd = scene.firstTokenIndex + scene.tokens.length;
    const splits = new Set<number>([scene.firstTokenIndex]);
    for (const marker of scene.markers) {
      if (referencedMarks.has(marker.name)) {
        splits.add(marker.beforeTokenIndex);
      }
    }
    for (const marker of scene.markers) {
      if (referencedMarks.has(marker.name)) {
        continue;
      }
      if (marker.beforeTokenIndex >= sceneEnd || splits.has(marker.beforeTokenIndex)) {
        notes.push({
          id: "marker.unused",
          severity: "note",
          sceneId: scene.sceneId,
          message: `Marker "${marker.name}" is never referenced by an action and splits no dialog — remove it`,
        });
      } else {
        splits.add(marker.beforeTokenIndex);
      }
    }
  }

  return { version: CRITIC_VERSION, notes };
}
