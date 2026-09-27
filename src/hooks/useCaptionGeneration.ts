import { useEffect, useRef, useState } from "react";
import type { CaptionCue, Recording } from "../core/src";
import { useNextEditorActions } from "./useNextEditorContext";
import { useCaptionStoreTrigger } from "./useCaptionStore";
import type { CaptionGenerationProgress } from "../captions/generateCaptions";

export type CaptionGenerationState =
  | { status: "idle" }
  | { status: "running"; progress: CaptionGenerationProgress | null }
  | { status: "failed"; message: string };

/** The narration to transcribe: a take has it in memory, an imported lesson may only link it. */
async function narrationOf(recording: Recording): Promise<Blob> {
  if (recording.audioBlob instanceof Blob) return recording.audioBlob;
  if (!recording.audioUrl) throw new Error("This recording has no narration to caption.");
  const response = await fetch(recording.audioUrl);
  if (!response.ok) throw new Error(`The narration could not be loaded (${response.status}).`);
  return response.blob();
}

/**
 * One captioning job: transcribes the narration, reports each state it goes through to
 * `update`, and hands the captions to `onCaptions` before it goes idle. `onSettled` runs last,
 * however the job ends. Outside the hook because the React Compiler cannot compile a function
 * holding `import()` or a `finally`.
 */
async function runCaptionJob(
  recording: Recording,
  controller: AbortController,
  job: {
    update: (state: CaptionGenerationState) => void;
    onCaptions: (language: string, cues: CaptionCue[]) => void;
    onSettled: () => void;
  },
): Promise<void> {
  try {
    // Loaded on demand: the model code is only paid for by authors who caption.
    const { generateCaptions } = await import("../captions/generateCaptions");
    const { language, cues } = await generateCaptions(recording, await narrationOf(recording), {
      signal: controller.signal,
      onProgress: (progress) => {
        if (!controller.signal.aborted) job.update({ status: "running", progress });
      },
    });
    if (cues.length === 0) {
      job.update({ status: "failed", message: "No speech was found in the narration." });
      return;
    }
    job.onCaptions(language, cues);
    job.update({ status: "idle" });
  } catch (error) {
    if (controller.signal.aborted) {
      job.update({ status: "idle" });
      return;
    }
    console.error("Caption generation failed:", error);
    job.update({
      status: "failed",
      message: error instanceof Error ? error.message : "Captions could not be generated.",
    });
  } finally {
    job.onSettled();
  }
}

/**
 * Generates captions for a recording's narration on this device (see
 * captions/generateCaptions.ts) and adds them as a track, shown at once.
 */
export function useCaptionGeneration() {
  const { addCaptionTrack } = useNextEditorActions();
  const captionTrigger = useCaptionStoreTrigger();
  const [state, setState] = useState<CaptionGenerationState>({ status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // A job outliving the player would keep its worker (and the model) alive.
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async (recording: Recording) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ status: "running", progress: null });
    await runCaptionJob(recording, controller, {
      update: setState,
      onCaptions: (language, cues) => {
        addCaptionTrack(recording.id, {
          id: `auto-${language}-${Date.now()}`,
          language,
          label: `${language.toUpperCase()} (auto)`,
          cues,
          default: !recording.captions?.length,
        });
        captionTrigger.setLanguage({ language });
        captionTrigger.setEnabled({ enabled: true });
      },
      onSettled: () => {
        if (abortRef.current === controller) abortRef.current = null;
      },
    });
  };

  const cancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ status: "idle" });
  };

  return { state, start, cancel };
}

/** "Downloading the speech model… 40%" and the like. */
export function describeCaptionGeneration(state: CaptionGenerationState): string {
  if (state.status === "failed") return state.message;
  if (state.status !== "running") return "";
  const progress = state.progress;
  if (!progress) return "Preparing the narration…";
  const percent = Math.round(progress.fraction * 100);
  return progress.phase === "model"
    ? `Downloading the speech model… ${percent}%`
    : `Transcribing… ${percent}%`;
}
