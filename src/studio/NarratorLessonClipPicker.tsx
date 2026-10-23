import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useAuth, useMyLessons } from "@next-editor/infra";
import HoverRing from "../components/hoverRing/HoverRing";
import { MIN_VOXCPM2_REFERENCE_SECONDS } from "./tts/customVoices";
import {
  CLIP_STEP_SECONDS,
  clampClipStart,
  clipLengthChoices,
  defaultClipLength,
  formatClipTime,
  type LessonClip,
  lessonClipSources,
  loadLessonNarration,
  maxClipStart,
  suggestClipStart,
} from "./tts/lessonVoiceClip";

/**
 * The "take a reference from one of your lessons" picker of the narrator voice
 * panel: pick one of the signed-in author's lessons, choose a window of its
 * narration (a steady stretch of speech is suggested), listen to it, and hand
 * it to the panel, which saves and selects it like a recorded or uploaded
 * sample. Loading and clip logic live in tts/lessonVoiceClip.ts.
 */

export interface NarratorLessonClipPickerProps {
  id: string;
  /** A render or another voice task is running. */
  disabled: boolean;
  /** Save `clip` as a narrator voice and select it. */
  onUseClip: (clip: LessonClip) => void;
  onClose: () => void;
}

const BUTTON_CLASS =
  "shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50";
const FIELD_CLASS =
  "min-w-0 rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Plays `lengthSeconds` of `narration` from `startSeconds`. Returns a stop
 * function; `onEnded` runs when the window plays out, not when it is stopped.
 */
function playClipWindow(
  narration: AudioBuffer,
  startSeconds: number,
  lengthSeconds: number,
  onEnded: () => void,
): () => void {
  const context = new AudioContext();
  const source = context.createBufferSource();
  source.buffer = narration;
  source.connect(context.destination);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    source.onended = null;
    // Closing the context ends the playback with it.
    context.close().catch(() => {});
  };
  source.onended = () => {
    stop();
    onEnded();
  };
  source.start(0, startSeconds, lengthSeconds);
  return stop;
}

/** A lesson's decoded narration, ready to clip. */
interface LoadedNarration {
  lessonId: string;
  title: string;
  buffer: AudioBuffer;
}

function LessonClipChooser({
  disabled,
  onUseClip,
}: Omit<NarratorLessonClipPickerProps, "id" | "onClose">) {
  const lessonsQuery = useMyLessons();
  const [lessonId, setLessonId] = useState("");
  const [narration, setNarration] = useState<LoadedNarration | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lengthSeconds, setLengthSeconds] = useState(0);
  const [startSeconds, setStartSeconds] = useState(0);
  const [listening, setListening] = useState(false);
  // Until the author moves the start, a new length re-suggests the start.
  const [startTouched, setStartTouched] = useState(false);
  const loadRef = useRef<AbortController | null>(null);
  const stopListeningRef = useRef<(() => void) | null>(null);
  const lessonFieldId = useId();
  const startFieldId = useId();
  const lengthFieldId = useId();

  // Closing the picker stops the clip and drops a lesson still loading.
  useEffect(
    () => () => {
      loadRef.current?.abort();
      loadRef.current = null;
      stopListeningRef.current?.();
      stopListeningRef.current = null;
    },
    [],
  );

  const stopListening = () => {
    stopListeningRef.current?.();
    stopListeningRef.current = null;
    setListening(false);
  };

  // A disabled picker cannot be stopped, and the panel disables it while the
  // microphone records: a clip still playing would bleed into that take.
  useEffect(() => {
    if (!disabled || !stopListeningRef.current) return;
    stopListeningRef.current();
    stopListeningRef.current = null;
    setListening(false);
  }, [disabled]);

  const sources = lessonsQuery.data
    ? lessonClipSources(lessonsQuery.data, window.location.origin)
    : [];

  const pickLesson = (id: string) => {
    stopListening();
    loadRef.current?.abort();
    loadRef.current = null;
    setLessonId(id);
    setStartTouched(false);
    setNarration(null);
    setLoading(false);
    setNotice(null);
    const source = sources.find((lesson) => lesson.id === id);
    if (!source) return;

    const controller = new AbortController();
    loadRef.current = controller;
    setLoading(true);
    setNotice(`Loading the narration of "${source.title}"…`);
    loadLessonNarration(source.neUrl, controller.signal)
      .then((buffer) => {
        if (controller.signal.aborted) return;
        if (!buffer) {
          setNotice("This lesson has no narration audio to take a reference from.");
          return;
        }
        const length = defaultClipLength(clipLengthChoices(buffer.duration));
        if (length === null) {
          setNotice(
            `This lesson's narration is shorter than ${MIN_VOXCPM2_REFERENCE_SECONDS}s, too short for a reference.`,
          );
          return;
        }
        const start = suggestClipStart(buffer.getChannelData(0), buffer.sampleRate, length);
        setNarration({ lessonId: id, title: source.title, buffer });
        setLengthSeconds(length);
        setStartSeconds(start);
        setNotice(
          `Suggested clip: ${formatClipTime(start)}–${formatClipTime(start + length)} of ${formatClipTime(buffer.duration)}.`,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setNotice(`The lesson's narration could not be loaded: ${messageOf(error)}`);
      })
      .finally(() => {
        if (loadRef.current !== controller) return;
        loadRef.current = null;
        setLoading(false);
      });
  };

  const duration = narration?.buffer.duration ?? 0;
  const lengthChoices = narration ? clipLengthChoices(duration) : [];
  const lastStart = narration ? maxClipStart(lengthSeconds, duration) : 0;

  const changeStart = (value: number) => {
    stopListening();
    setStartTouched(true);
    setStartSeconds(clampClipStart(value, lengthSeconds, duration));
  };

  const changeLength = (value: number) => {
    stopListening();
    setLengthSeconds(value);
    if (narration && !startTouched) {
      const { buffer } = narration;
      const start = suggestClipStart(buffer.getChannelData(0), buffer.sampleRate, value);
      setStartSeconds(start);
      setNotice(
        `Suggested clip: ${formatClipTime(start)}–${formatClipTime(start + value)} of ${formatClipTime(buffer.duration)}.`,
      );
      return;
    }
    setStartSeconds(clampClipStart(startSeconds, value, duration));
  };

  const toggleListening = () => {
    if (!narration) return;
    if (stopListeningRef.current) {
      stopListening();
      return;
    }
    stopListeningRef.current = playClipWindow(narration.buffer, startSeconds, lengthSeconds, () => {
      stopListeningRef.current = null;
      setListening(false);
    });
    setListening(true);
  };

  const takeClip = () => {
    if (!narration) return;
    stopListening();
    onUseClip({
      narration: narration.buffer,
      startSeconds,
      lengthSeconds,
      lessonTitle: narration.title,
    });
  };

  let lessonField;
  if (lessonsQuery.isPending) {
    lessonField = <p className="text-[12px] text-slate-400">Loading your lessons…</p>;
  } else if (lessonsQuery.data === undefined) {
    lessonField = (
      <p className="text-[12px] text-amber-300">
        Your lessons could not be loaded: {messageOf(lessonsQuery.error)}
      </p>
    );
  } else if (sources.length === 0) {
    lessonField = (
      <p className="text-[12px] text-slate-400">
        You have no lessons yet. Upload a narrated lesson, then take a reference from it here.
      </p>
    );
  } else {
    lessonField = (
      <div className="flex items-center gap-2">
        <label htmlFor={lessonFieldId} className="w-12 shrink-0 text-[12px] text-slate-400">
          Lesson
        </label>
        <select
          id={lessonFieldId}
          value={lessonId}
          disabled={disabled}
          onChange={(event) => pickLesson(event.target.value)}
          className={`${FIELD_CLASS} flex-1`}
        >
          <option value="">Choose a lesson…</option>
          {sources.map((lesson) => (
            <option key={lesson.id} value={lesson.id}>
              {lesson.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <>
      {lessonField}
      {narration && narration.lessonId === lessonId ? (
        <>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={startFieldId} className="w-12 shrink-0 text-[12px] text-slate-400">
              Start
            </label>
            <input
              id={startFieldId}
              type="range"
              min={0}
              max={lastStart}
              step={CLIP_STEP_SECONDS}
              value={startSeconds}
              disabled={disabled || lastStart === 0}
              onChange={(event) => changeStart(Number(event.target.value))}
              aria-valuetext={`${formatClipTime(startSeconds)} of ${formatClipTime(duration)}`}
              className="min-w-0 flex-1 accent-sky-500 disabled:opacity-50"
            />
            <span className="shrink-0 font-mono text-[12px] text-slate-300">
              {formatClipTime(startSeconds)}–{formatClipTime(startSeconds + lengthSeconds)} /{" "}
              {formatClipTime(duration)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={lengthFieldId} className="w-12 shrink-0 text-[12px] text-slate-400">
              Length
            </label>
            <select
              id={lengthFieldId}
              value={lengthSeconds}
              disabled={disabled}
              onChange={(event) => changeLength(Number(event.target.value))}
              className={FIELD_CLASS}
            >
              {lengthChoices.map((length) => (
                <option key={length} value={length}>
                  {length}s
                </option>
              ))}
            </select>
            <span className="flex-1" />
            <button
              type="button"
              disabled={disabled}
              onClick={toggleListening}
              className={BUTTON_CLASS}
              title="Play this clip of the lesson's narration"
            >
              {listening ? "Stop" : "Listen"}
              <HoverRing />
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={takeClip}
              className={BUTTON_CLASS}
              title="Save this clip as a narrator reference and select it"
            >
              Use this clip
              <HoverRing />
            </button>
          </div>
        </>
      ) : null}
      {/* Always mounted, so loading and failure notices are announced. */}
      <div role="status" aria-busy={loading}>
        {notice ? <p className="mt-1 text-[12px] text-slate-400">{notice}</p> : null}
      </div>
    </>
  );
}

export default function NarratorLessonClipPicker({
  id,
  disabled,
  onUseClip,
  onClose,
}: NarratorLessonClipPickerProps) {
  const { user, isLoading } = useAuth();
  const headingId = useId();

  let body;
  if (isLoading) {
    body = <p className="text-[12px] text-slate-400">Checking your sign-in…</p>;
  } else if (!user) {
    body = (
      <p className="text-[12px] text-slate-400">
        Sign in to take a reference from one of your lessons.
      </p>
    );
  } else {
    body = <LessonClipChooser disabled={disabled} onUseClip={onUseClip} />;
  }

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="mt-2 rounded-md border border-slate-600 bg-[#10141b] p-2"
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 id={headingId} className="flex-1 text-[12px] font-bold text-slate-200">
          Reference from one of your lessons
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the lesson picker"
          className="shrink-0 rounded-md bg-[#222d3b] p-1.5 text-[#8db8ef] transition-colors hover:bg-[#2a3a4d]"
          title="Close"
        >
          <X aria-hidden="true" className="size-3.5" />
          <HoverRing />
        </button>
      </div>
      {body}
      <p className="mt-2 text-[12px] text-slate-400">
        A lesson narrated by Studio's Burmese voice is already a synthesized copy. A clip of your
        own recorded voice gives the most faithful reference.
      </p>
    </section>
  );
}
