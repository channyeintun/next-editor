import type { ExtractedNarration } from "./markers";
import type { LessonScript } from "./schema";

/**
 * Advisory script critic (docs/agent-lesson-production.md §8/§12 M4): purely
 * mechanical lint notes against the versioned persona guide
 * (docs/studio-persona.md). Advisory by construction — the critic can propose
 * structured notes but has no blocking power and no approve verdict; a human
 * remains the editorial gate. Version-locked to the persona guide.
 */

export const CRITIC_VERSION = 1;

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

const MAX_SENTENCE_WORDS = 24;
const MIN_WPM = 110;
const MAX_WPM = 170;
const MAX_SCENES = 5;
const MAX_NARRATION_MS = 120_000;

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

    // Banned filler (longest phrases first so "just simply" wins over "simply").
    for (const phrase of [...BANNED_PHRASES_V1].sort((a, b) => b.length - a.length)) {
      if (new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lowered)) {
        notes.push({
          id: `phrase.${phrase.replace(/\s+/g, "-")}`,
          severity: "note",
          sceneId: scene.id,
          message: `Banned phrase "${phrase}" in scene "${scene.id}" (persona guide v${CRITIC_VERSION})`,
        });
        break;
      }
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
