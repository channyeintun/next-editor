import { useEffect, useRef, useState } from "react";
import { readStoredPreference, writeStoredPreference } from "../stores/preferenceStorage";
import type { StudioNarrationProvider } from "./narrationLanguage";
import {
  deleteCustomVoice,
  isVoxCpm2ReferenceReady,
  listCustomVoices,
  MAX_SAMPLE_SECONDS,
  MIN_SAMPLE_SECONDS,
  MIN_VOXCPM2_REFERENCE_SECONDS,
  prepareVoiceSample,
  saveCustomVoice,
  type SavedCustomVoice,
  voxCpm2ReferenceTooShort,
} from "./tts/customVoices";
import { synthesizeModalVoxCpm2Wav } from "./tts/modalVoxCpm2Synth";
import { synthesizePocketWav } from "./tts/pocketSynth";
import { customVoiceProfileOf, modalVoxCpm2BurmeseProfileOf } from "./tts/profiles";

/**
 * The narrator voice library inside the Studio render panel. Narrator
 * references live in this browser's IndexedDB: upload or record one, preview
 * it, delete it, and pick the one a render narrates with. The selected sample
 * either clones Pocket-TTS locally or conditions Burmese VoxCPM2 through the
 * authenticated Worker at render time. AthanLab voices come from the user's
 * AthanLab account instead (AthanLabPanel), so with that provider only the
 * voice-task status region is rendered — the library stays loaded for when
 * the author switches back.
 *
 * StudioController renders with the voice this panel reports, and keeps Start
 * render and the provider select disabled while a voice task it reports runs.
 */

const VOICE_CHOICE_KEY = "next-editor:studio:voice-choice";

/** The voice task in progress, as StudioController sees it. */
export interface NarratorVoiceTask {
  /** The running task's notice, e.g. "Preparing the sample (24 kHz mono)…". */
  busy: string | null;
  recording: boolean;
}

export interface NarratorVoicePanelProps {
  provider: StudioNarrationProvider;
  /** A render is running. */
  disabled: boolean;
  /**
   * The voice dialogs are synthesized with, or null for the script default.
   * Reported once the library has been read, and on every change after.
   */
  onSelectedVoiceChange: (voice: SavedCustomVoice | null) => void;
  onTaskChange: (task: NarratorVoiceTask) => void;
  /** A voice task failed; the message is shown in the console's alert. */
  onError: (message: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs one voice task with `notice` shown as busy, reporting a failure through
 * `onError`. The try blocks of this panel live at module level so the
 * component compiles under the React Compiler.
 */
async function runVoiceTask(
  setBusy: (notice: string | null) => void,
  onError: (message: string) => void,
  notice: string,
  task: () => Promise<void>,
): Promise<void> {
  setBusy(notice);
  try {
    await task();
  } catch (error) {
    onError(messageOf(error));
  } finally {
    setBusy(null);
  }
}

/** Decodes a narrator sample to the reference format, checks it, and stores it. */
async function prepareAndSaveVoice(
  bytes: ArrayBuffer,
  name: string,
  provider: StudioNarrationProvider,
): Promise<SavedCustomVoice> {
  const samples = await prepareVoiceSample(bytes);
  if (provider === "voxcpm2" && voxCpm2ReferenceTooShort(samples)) {
    throw new Error(
      `Burmese narration requires at least ${MIN_VOXCPM2_REFERENCE_SECONDS}s of clear reference speech`,
    );
  }
  return saveCustomVoice(name, samples);
}

/** Synthesizes the provider's preview sentence with `voice` and plays it. */
async function playVoicePreview(
  voice: SavedCustomVoice,
  provider: StudioNarrationProvider,
): Promise<void> {
  const wav =
    provider === "voxcpm2"
      ? await synthesizeModalVoxCpm2Wav(
          modalVoxCpm2BurmeseProfileOf(voice),
          "မင်္ဂလာပါ။ ဒီအသံနဲ့ သင်ခန်းစာတစ်လျှောက် တစ်သမတ်တည်း ရှင်းပြပေးပါမယ်။",
          1,
        )
      : await synthesizePocketWav(
          customVoiceProfileOf(voice),
          "Hi! This is my cloned voice, reading a quick preview.",
          1,
        );
  const url = URL.createObjectURL(new Blob([wav.slice() as BlobPart], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

/** A microphone take in progress. */
interface VoiceTake {
  recorder: MediaRecorder;
  stream: MediaStream;
  stopTimer: number;
}

/**
 * Opens the microphone and starts a take that stops itself at
 * MAX_SAMPLE_SECONDS, the most the engine conditions on. `onStart` receives
 * the take once it records, and `onStop` its audio once it stops. A grant that
 * arrives after `isMounted` turns false only releases the microphone.
 */
async function startVoiceTake(
  isMounted: () => boolean,
  onStart: (take: VoiceTake) => void,
  onStop: (audio: Blob) => void,
): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  if (!isMounted()) {
    // The console unmounted while the permission prompt was open.
    for (const track of stream.getTracks()) track.stop();
    return;
  }
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  const take: VoiceTake = { recorder, stream, stopTimer: 0 };
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.onstop = () => {
    window.clearTimeout(take.stopTimer);
    for (const track of stream.getTracks()) track.stop();
    onStop(new Blob(chunks, { type: recorder.mimeType }));
  };
  recorder.start();
  take.stopTimer = window.setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, MAX_SAMPLE_SECONDS * 1000);
  onStart(take);
}

/** Ends a take without keeping it: its onstop never runs, so nothing is saved. */
function discardVoiceTake(take: VoiceTake): void {
  window.clearTimeout(take.stopTimer);
  take.recorder.onstop = null;
  if (take.recorder.state !== "inactive") take.recorder.stop();
  for (const track of take.stream.getTracks()) track.stop();
}

export default function NarratorVoicePanel({
  provider,
  disabled,
  onSelectedVoiceChange,
  onTaskChange,
  onError,
}: NarratorVoicePanelProps) {
  const [customVoices, setCustomVoices] = useState<SavedCustomVoice[]>([]);
  // Whether the library has been read (or failed to), so the empty pre-load
  // list is never reported as the selection.
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  const [voiceChoice, setVoiceChoice] = useState<string>(
    () => readStoredPreference(VOICE_CHOICE_KEY) ?? "default",
  );
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const voiceFileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceSelectRef = useRef<HTMLSelectElement | null>(null);
  const voiceTakeRef = useRef<VoiceTake | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    void listCustomVoices()
      .then(setCustomVoices)
      .catch((error: unknown) => console.warn("Narrator voices unavailable:", error))
      .finally(() => setVoicesLoaded(true));
  }, []);

  // Leaving the console mid-take stops the microphone at once and discards the
  // take: once unmounted, nothing can show it or confirm saving it.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const take = voiceTakeRef.current;
      voiceTakeRef.current = null;
      if (take) discardVoiceTake(take);
    };
  }, []);

  const selectedVoice = customVoices.find((voice) => voice.id === voiceChoice) ?? null;
  const selectedVoiceId = selectedVoice?.id ?? null;
  useEffect(() => {
    if (voicesLoaded) onSelectedVoiceChange(selectedVoice);
  }, [selectedVoiceId, voicesLoaded]);

  useEffect(() => {
    onTaskChange({ busy: voiceBusy, recording: voiceRecording });
  }, [voiceBusy, voiceRecording]);

  const selectedVoiceIsBurmeseReady =
    selectedVoice !== null && isVoxCpm2ReferenceReady(selectedVoice);
  const requiredVoiceSeconds =
    provider === "voxcpm2" ? MIN_VOXCPM2_REFERENCE_SECONDS : MIN_SAMPLE_SECONDS;

  const chooseVoice = (value: string) => {
    setVoiceChoice(value);
    writeStoredPreference(VOICE_CHOICE_KEY, value);
  };

  const saveVoiceFromAudio = (bytes: ArrayBuffer, suggestedName: string) =>
    runVoiceTask(setVoiceBusy, onError, "Preparing the sample (24 kHz mono)…", async () => {
      const voice = await prepareAndSaveVoice(bytes, suggestedName, provider);
      setCustomVoices(await listCustomVoices());
      chooseVoice(voice.id);
    });

  const handleVoiceFile = (file: File) => {
    void file
      .arrayBuffer()
      .then((bytes) => saveVoiceFromAudio(bytes, file.name.replace(/\.[^.]+$/, "")))
      .catch((error: unknown) => onError(messageOf(error)));
  };

  const toggleVoiceRecording = () => {
    const active = voiceTakeRef.current;
    if (active) {
      active.recorder.stop();
      return;
    }
    startVoiceTake(
      () => mountedRef.current,
      (take) => {
        voiceTakeRef.current = take;
        setVoiceRecording(true);
      },
      (audio) => {
        voiceTakeRef.current = null;
        setVoiceRecording(false);
        void audio
          .arrayBuffer()
          .then((bytes) => saveVoiceFromAudio(bytes, "My voice"))
          .catch((error: unknown) => onError(messageOf(error)));
      },
    ).catch((error: unknown) => onError(messageOf(error)));
  };

  const previewVoice = () => {
    if (!selectedVoice) return;
    void runVoiceTask(
      setVoiceBusy,
      onError,
      `Synthesizing a preview with "${selectedVoice.name}"…`,
      () => playVoicePreview(selectedVoice, provider),
    );
  };

  const removeVoice = async () => {
    if (!selectedVoice) return;
    if (!window.confirm(`Delete cloned voice "${selectedVoice.name}"?`)) return;
    await deleteCustomVoice(selectedVoice.id);
    setCustomVoices(await listCustomVoices());
    chooseVoice("default");
    // The delete button unmounts with the voice; keep focus on the voice
    // select, which stays mounted, instead of dropping it to the page.
    voiceSelectRef.current?.focus();
  };

  return (
    <>
      {/* AthanLab voices come from the user's AthanLab account (AthanLabPanel);
          the browser-local clone/reference voices are for the others. */}
      {provider === "athanlab" ? null : (
        <div className="mt-2 flex items-center gap-2">
          <select
            ref={voiceSelectRef}
            value={selectedVoice ? selectedVoice.id : "default"}
            disabled={disabled || voiceBusy !== null}
            onChange={(event) => chooseVoice(event.target.value)}
            aria-label="Narrator voice"
            className="min-w-0 flex-1 rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50"
          >
            <option value="default">
              {provider === "voxcpm2" ? "voice: reference required" : "voice: script default"}
            </option>
            {customVoices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                voice: {voice.name} ({provider === "voxcpm2" ? "reference" : "cloned"})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled || voiceBusy !== null || voiceRecording}
            onClick={() => voiceFileInputRef.current?.click()}
            className="shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
            title={`Upload ${requiredVoiceSeconds}–${MAX_SAMPLE_SECONDS}s of clear narrator speech`}
          >
            {provider === "voxcpm2" ? "Reference…" : "Clone…"}
          </button>
          <button
            type="button"
            disabled={disabled || voiceBusy !== null}
            onClick={toggleVoiceRecording}
            className={`shrink-0 rounded-md px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              voiceRecording
                ? "bg-[#3b2222] text-[#ef8d8d] hover:bg-[#4d2a2a]"
                : "bg-[#222d3b] text-[#8db8ef] hover:bg-[#2a3a4d]"
            }`}
            title={`Record ${requiredVoiceSeconds}–${MAX_SAMPLE_SECONDS}s of narrator speech`}
          >
            {voiceRecording ? "Stop" : "Record"}
          </button>
          {selectedVoice ? (
            <>
              <button
                type="button"
                disabled={
                  disabled ||
                  voiceBusy !== null ||
                  voiceRecording ||
                  (provider === "voxcpm2" && !selectedVoiceIsBurmeseReady)
                }
                onClick={previewVoice}
                className="shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
                title="Synthesize a short preview sentence with this voice"
              >
                Preview
              </button>
              <button
                type="button"
                disabled={disabled || voiceBusy !== null || voiceRecording}
                onClick={() => {
                  void removeVoice();
                }}
                aria-label="Delete voice"
                className="shrink-0 rounded-md bg-[#3b2222] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#ef8d8d] transition-colors hover:bg-[#4d2a2a] disabled:cursor-not-allowed disabled:opacity-50"
                title="Delete this reference voice from the browser"
              >
                <span aria-hidden="true">✕</span>
              </button>
            </>
          ) : null}
          <input
            ref={voiceFileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                handleVoiceFile(file);
              }
            }}
          />
        </div>
      )}
      {/* Always mounted, so the voice-task notices it fills are announced. */}
      <div role="status">
        {voiceBusy ? <p className="mt-1 text-[12px] text-slate-400">{voiceBusy}</p> : null}
        {voiceRecording ? (
          <p className="mt-1 text-[12px] text-amber-300">
            Recording… speak naturally for at least {requiredVoiceSeconds}s; stops automatically at{" "}
            {MAX_SAMPLE_SECONDS}s.
          </p>
        ) : null}
      </div>
      {provider === "voxcpm2" ? (
        <p
          className={`mt-1 text-[12px] ${
            selectedVoiceIsBurmeseReady ? "text-slate-400" : "text-amber-300"
          }`}
        >
          A {MIN_VOXCPM2_REFERENCE_SECONDS}–{MAX_SAMPLE_SECONDS}s narrator reference is required so
          every dialog keeps the same character. The selected sample goes to your private Modal
          deployment with each narration job, along with the fixed Burmese educator prompt. Modal
          stores each job's input and keeps its audio for up to 7 days. The LessonScript must use{" "}
          <span className="font-mono text-slate-300">locale: my-MM</span>.
        </p>
      ) : null}
    </>
  );
}
