import type { ExtractedNarration } from "./markers";
import type { LessonScript } from "./schema";

/**
 * Advisory script critic (docs/agent-lesson-production.md §8/§12 M4): purely
 * mechanical lint notes against the versioned persona guide
 * (docs/studio-persona.md). Advisory by construction — the critic can propose
 * structured notes but has no blocking power and no approve verdict; a human
 * remains the editorial gate. Version-locked to the persona guide.
 */

export const CRITIC_VERSION = 2;

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

const MAX_SENTENCE_WORDS = 24;
const MIN_WPM = 110;
const MAX_WPM = 170;
const MAX_SCENES = 5;
const MAX_NARRATION_MS = 120_000;
/** Pre-synthesis pacing estimate (~140 spoken wpm for the current profile). */
const ESTIMATED_WPM = 140;

/** Rough narration length before any audio exists — critic input only. */
export function estimateNarrationDurationMs(tokenCount: number): number {
  return Math.round((tokenCount / ESTIMATED_WPM) * 60_000);
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

export function critiqueScript(
  script: LessonScript,
  extracted: ExtractedNarration,
  narrationDurationMs: number,
): ScriptCritique {
  const notes: CritiqueNote[] = [];

  // Pacing: words per minute across the measured narration.
  const words = extracted.tokens.length;
  const minutes = narrationDurationMs / 60_000;
  const wpm = minutes > 0 ? Math.round(words / minutes) : 0;
  if (wpm > MAX_WPM) {
    notes.push({
      id: "pacing.fast",
      severity: "suggestion",
      message: `Narration averages ${wpm} wpm (band ${MIN_WPM}–${MAX_WPM}); consider trimming words or slowing the voice profile`,
    });
  } else if (wpm < MIN_WPM) {
    notes.push({
      id: "pacing.slow",
      severity: "suggestion",
      message: `Narration averages ${wpm} wpm (band ${MIN_WPM}–${MAX_WPM}); consider tightening pauses or the voice profile rate`,
    });
  }

  // Scope: one concept per lesson.
  if (script.scenes.length > MAX_SCENES) {
    notes.push({
      id: "scope.scenes",
      severity: "suggestion",
      message: `${script.scenes.length} scenes (guide suggests ≤ ${MAX_SCENES}) — is this still one concept?`,
    });
  }
  if (narrationDurationMs > MAX_NARRATION_MS) {
    notes.push({
      id: "scope.length",
      severity: "suggestion",
      message: `Narration runs ${Math.round(narrationDurationMs / 1000)}s (guide caps at ${MAX_NARRATION_MS / 1000}s)`,
    });
  }

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
        message: `Banned phrase "${phrase}" in scene "${scene.id}" (persona guide v${CRITIC_VERSION})`,
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
        message: `Scene "${scene.id}" reads instead of talks — contract: ${readAloud.join(", ")} (persona guide v${CRITIC_VERSION})`,
      });
    }

    // Sentence length.
    for (const sentence of sentencesOf(displayText)) {
      const sentenceWords = sentence.split(/\s+/).length;
      if (sentenceWords > MAX_SENTENCE_WORDS) {
        notes.push({
          id: "sentence.long",
          severity: "suggestion",
          sceneId: scene.id,
          message: `A ${sentenceWords}-word sentence in scene "${scene.id}" (ceiling ${MAX_SENTENCE_WORDS}): "${sentence.slice(0, 60)}…"`,
        });
      }
    }

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

  // Marker hygiene: unused markers are legal but usually leftovers.
  const referencedMarks = new Set<string>();
  for (const scene of script.scenes) {
    for (const action of scene.actions) {
      if ("mark" in action.at) {
        referencedMarks.add(action.at.mark);
      }
    }
  }
  for (const name of extracted.markers.keys()) {
    if (!referencedMarks.has(name)) {
      notes.push({
        id: "marker.unused",
        severity: "note",
        message: `Marker "${name}" is never referenced by an action`,
      });
    }
  }

  return { version: CRITIC_VERSION, notes };
}
