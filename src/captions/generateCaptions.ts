import type { CaptionCue, Recording } from "../core/src/types";
import { WHISPER_SAMPLE_RATE } from "./whisper/melSpectrogram";
import type { TranscribedSegment } from "./whisper/whisperTranscriber";
import { proxy, transfer, wrap } from "comlink";
import type { CaptionWorkerApi, CaptionWorkerProgress } from "./whisper/captionWorker";
import { WORKSPACE_LESSON_TYPE_LABELS, isWorkspaceTextFile } from "../types/workspace";

// ============================================================================
// Captions for a human-recorded narration, generated on this device: the audio
// never leaves the browser. Whisper runs in a worker (captionWorker.ts); this
// side decodes the narration, prompts the model with the lesson's vocabulary,
// and turns its segments into caption cues on the recording's clock.
// ============================================================================

/** Cues longer than this are split, so each fits a caption line or two. */
const MAX_CUE_CHARACTERS = 84;
const MAX_CUE_MS = 7_000;
/** A long, slow segment is split no finer than this, or its cues would flicker by word. */
const MIN_SPLIT_CHARACTERS = 32;

export type CaptionGenerationProgress =
  | { phase: "model"; fraction: number }
  | { phase: "transcribe"; fraction: number };

/** The narration as 16 kHz mono samples: every channel averaged. */
async function decodeNarration(audio: Blob): Promise<Float32Array<ArrayBuffer>> {
  const context = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  const buffer = await context.decodeAudioData(await audio.arrayBuffer());
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < mono.length; index++) {
      mono[index] += data[index] / buffer.numberOfChannels;
    }
  }
  return mono;
}

/** Display names for libraries the model otherwise hears as ordinary words. */
const LIBRARY_NAMES: Record<string, string> = {
  react: "React",
  "react-dom": "React DOM",
  "react-router": "React Router",
  typescript: "TypeScript",
  vite: "Vite",
  vue: "Vue",
  "solid-js": "Solid",
  svelte: "Svelte",
  htmx: "htmx",
  "htmx.org": "htmx",
  express: "Express",
  axios: "Axios",
  tailwindcss: "Tailwind CSS",
  zod: "Zod",
  xstate: "XState",
  "@tanstack/react-query": "TanStack Query",
  "@tanstack/react-router": "TanStack Router",
  "@tanstack/react-virtual": "TanStack Virtual",
  "@tanstack/react-start": "TanStack Start",
  nitro: "Nitro",
  next: "Next.js",
  prisma: "Prisma",
  jest: "Jest",
  vitest: "Vitest",
};

/**
 * What the lesson is likely to say that a speech model mishears: its libraries (from
 * package.json), its language, and its files, as the lesson ends (by then it has
 * everything it talks about). Whisper takes it as a prompt.
 */
export function buildCaptionPrompt(recording: Recording): string | undefined {
  const snapshot = recording.workspaceEvents?.at(-1)?.snapshot ?? recording.workspaceSnapshot;
  if (!snapshot) return undefined;
  const { project } = snapshot;

  const terms = new Set<string>();
  const lessonLabel = WORKSPACE_LESSON_TYPE_LABELS[project.lessonType];
  if (lessonLabel) terms.add(lessonLabel);

  const manifest = project.files["package.json"];
  if (manifest && isWorkspaceTextFile(manifest)) {
    try {
      const pkg = JSON.parse(manifest.content) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      for (const name of [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]) {
        if (name.startsWith("@types/")) continue;
        terms.add(LIBRARY_NAMES[name] ?? name);
      }
    } catch {
      // A manifest mid-edit is not JSON; the files still help.
    }
  }

  const files = Object.keys(project.files)
    .map((path) => path.split("/").pop() ?? path)
    .filter((name) => !name.startsWith(".") && name !== "package-lock.json")
    .slice(0, 20);

  if (terms.size === 0 && files.length === 0) return undefined;
  const using = [...terms].slice(0, 30).join(", ");
  return `A coding lesson${using ? ` using ${using}` : ""}${
    files.length > 0 ? `, in ${files.join(", ")}` : ""
  }.`;
}

/** Where a long cue may break: between sentences, then clauses, then words. */
const BREAKS = [/(?<=[.!?])\s+/, /(?<=[,;:])\s+/, /\s+/];

/** Joins parts greedily into pieces of at most `limit` characters. */
function pack(parts: readonly string[], limit: number): string[] {
  const pieces: string[] = [];
  let current = "";
  for (const part of parts) {
    const next = current ? `${current} ${part}` : part;
    if (next.length > limit && current) {
      pieces.push(current);
      current = part;
    } else {
      current = next;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Splits `text` into pieces of at most `limit` characters, at the widest break that does. */
function splitText(text: string, limit: number, level = 0): string[] {
  if (text.length <= limit || level >= BREAKS.length) return [text];
  const parts = text.split(BREAKS[level]).filter(Boolean);
  if (parts.length < 2) return splitText(text, limit, level + 1);
  return pack(parts, limit).flatMap((piece) => splitText(piece, limit, level + 1));
}

/**
 * Caption cues from Whisper's segments: on the recording's clock (the narration starts
 * `offsetMs` into it), within its length, and split so no cue runs long in text or in
 * time. A split shares its segment's time by characters.
 */
export function segmentsToCues(
  segments: readonly TranscribedSegment[],
  offsetMs: number,
  durationMs: number,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const segment of segments) {
    const start = Math.min(durationMs, offsetMs + segment.start * 1000);
    const end = Math.min(durationMs, offsetMs + segment.end * 1000);
    if (end <= start) continue;
    // Characters that fit in MAX_CUE_MS at this segment's pace.
    const paced = Math.floor((segment.text.length * MAX_CUE_MS) / (end - start));
    const limit = Math.min(MAX_CUE_CHARACTERS, Math.max(MIN_SPLIT_CHARACTERS, paced));
    const pieces = splitText(segment.text, limit);
    const characters = pieces.reduce((total, piece) => total + piece.length, 0);
    let cursor = start;
    for (const piece of pieces) {
      const pieceEnd = cursor + ((end - start) * piece.length) / characters;
      cues.push({ start: Math.round(cursor), end: Math.round(pieceEnd), text: piece });
      cursor = pieceEnd;
    }
  }
  return cues;
}

/**
 * Transcribes a recording's narration on this device. The first run downloads the
 * speech model (~79 MB, cached after that); both phases report progress.
 */
export async function generateCaptions(
  recording: Recording,
  audio: Blob,
  options: {
    onProgress?: (progress: CaptionGenerationProgress) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ language: string; cues: CaptionCue[] }> {
  const samples = await decodeNarration(audio);
  options.signal?.throwIfAborted();

  const worker = new Worker(new URL("./whisper/captionWorker.ts", import.meta.url), {
    name: "next-editor-captions",
    type: "module",
  });
  try {
    // Comlink settles a call only on a reply, so a worker that dies (or an abort, which
    // terminates it) must reject the wait itself.
    const stopped = new Promise<never>((_, reject) => {
      worker.addEventListener("error", (event) =>
        reject(new Error(event.message || "Captioning failed")),
      );
      options.signal?.addEventListener(
        "abort",
        () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
    // Once the call has settled, a later rejection (an abort after the fact) is nobody's.
    stopped.catch(() => {});
    const onProgress = (progress: CaptionWorkerProgress) =>
      options.onProgress?.(
        progress.phase === "model"
          ? {
              phase: "model",
              fraction: progress.totalBytes > 0 ? progress.loadedBytes / progress.totalBytes : 0,
            }
          : {
              phase: "transcribe",
              fraction:
                progress.totalSeconds > 0 ? progress.doneSeconds / progress.totalSeconds : 0,
            },
      );
    const transcript = await Promise.race([
      wrap<CaptionWorkerApi>(worker).transcribe(
        transfer({ samples, prompt: buildCaptionPrompt(recording) }, [samples.buffer]),
        proxy(onProgress),
      ),
      stopped,
    ]);
    return {
      language: transcript.language,
      cues: segmentsToCues(
        transcript.segments,
        recording.audioStartOffsetMs ?? 0,
        recording.duration,
      ),
    };
  } finally {
    worker.terminate();
  }
}
