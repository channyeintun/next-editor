import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  invalidateAthanLabAccount,
  UploadLessonModal,
  useAuth,
  useStudioCapabilities,
} from "@next-editor/infra";
import { NextEditorActorContext } from "../contexts/NextEditorActorContext";
import { useNextEditorActions } from "../hooks/useNextEditorContext";
import { useRuntimePanelStore } from "../contexts/RuntimePanelStoreContext";
import { useSlidesStore } from "../contexts/SlidesStoreContext";
import { useWhiteboardStore } from "../contexts/WhiteboardStoreContext";
import { useWorkspaceActions } from "../hooks/useWorkspace";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
  useWebContainerRuntimeSnapshotGetter,
} from "../hooks/useWebContainerRuntime";
import { usePreviewPanel } from "../contexts/PreviewPanelContext";
import { usePreviewAdapterHandle } from "../contexts/PreviewAdapterHandleContext";
import { markTourSeen } from "../components/tour/productTour";
import { useRecordingSettings, useRecordingSettingsTrigger } from "../hooks/useRecordingSettings";
import { readStoredPreference, writeStoredPreference } from "../stores/preferenceStorage";
import { acquireDisplayStream, isScreenCaptureSupported } from "../utils/displayCapture";
import { downloadBlob } from "../utils/downloadBlob";
import { describeDraftDescription, describeDraftProvenance } from "./draftProvenance";
import { canonicalJson } from "./hash";
import { buildPlanFromScript } from "./inPageDirector";
import {
  defaultRuntimeModeOf,
  parseRuntimeModeParam,
  shouldAutostartRender,
  type StudioPlan,
  type StudioRuntimeMode,
} from "./plan";
import { checkRepeatability, runExposedForSelection, sourceRevisionOf } from "./runSelection";
import {
  DEFAULT_STUDIO_PLAN_SLUG,
  STUDIO_SOURCES,
  parseLessonScriptYaml,
  sourceRuntimeDefault,
  type StudioLessonSource,
} from "./plans";
import type { ActionReceipt, StudioCheckResult } from "./report";
import { CheckList, ReceiptList, RepeatabilityVerdict } from "./StudioRunResults";
import {
  deleteCustomVoice,
  listCustomVoices,
  MAX_SAMPLE_SECONDS,
  MIN_SAMPLE_SECONDS,
  MIN_VOXCPM2_REFERENCE_SECONDS,
  prepareVoiceSample,
  saveCustomVoice,
  type SavedCustomVoice,
  VOICE_SAMPLE_RATE,
} from "./tts/customVoices";
import {
  athanLabProfileOf,
  customVoiceProfileOf,
  modalVoxCpm2BurmeseProfileOf,
  type VoiceProfile,
} from "./tts/profiles";
import { synthesizeModalVoxCpm2Wav } from "./tts/modalVoxCpm2Synth";
import { synthesizePocketWav } from "./tts/pocketSynth";
import { critiqueScript, type CritiqueNote } from "./script/critic";
import { extractScriptNarration } from "./script/markers";
import { runStudioRender, type StudioRenderOptions, type StudioRunResult } from "./runStudioRender";
import type { RenderSemantics } from "./compare";
import {
  isStudioNarrationProvider,
  narrationLanguageOf,
  narrationProviderLabel,
  validateNarrationLanguage,
  type StudioNarrationProvider,
} from "./narrationLanguage";
import AthanLabPanel from "./AthanLabPanel";

/**
 * The studio render console: pick a lesson (checked-in scripts auto-register;
 * additional LessonScript YAML can be imported right here), render it into a
 * recorded lesson entirely client-side, and read receipts, QA gates, and the
 * two-render repeatability verdict (docs/agent-lesson-production.md). Results
 * are also published on `window.__NEXT_EDITOR_STUDIO__` so an automation
 * harness can read them without scraping the DOM.
 */

// Imported-at-runtime scripts (YAML text by slug), surviving reloads within
// the browsing session so an import → render → reload → re-render loop works.
const IMPORTED_SCRIPTS_KEY = "next-editor:studio:imported-scripts";
const VOICE_CHOICE_KEY = "next-editor:studio:voice-choice";
const NARRATION_PROVIDER_KEY = "next-editor:studio:narration-provider";

function readStoredNarrationProvider(): StudioNarrationProvider {
  const stored = readStoredPreference(NARRATION_PROVIDER_KEY);
  return isStudioNarrationProvider(stored) ? stored : "pocket";
}

function storeNarrationProvider(provider: StudioNarrationProvider): void {
  writeStoredPreference(NARRATION_PROVIDER_KEY, provider);
}

/** Until <AthanLabPanel> reports, a render with AthanLab cannot start. */
const ATHANLAB_NOT_REPORTED = { ready: false, reason: "Checking your AthanLab setup…" };

/** The non-script-source refusal, shared by the Start guard and runRender. */
const BURMESE_SCRIPT_ONLY_ERROR = "Burmese narration is available for LessonScript sources only";

/**
 * Why the selected lesson cannot be narrated by the selected provider, or null.
 * `scriptLocale` is null for a plan source, or a script that fails to parse
 * (runRender reports the schema error).
 */
function narrationSetupErrorOf(
  source: StudioLessonSource | undefined,
  scriptLocale: string | null,
  provider: StudioNarrationProvider,
): string | null {
  if (!source) return null;
  if (source.kind === "plan") return provider === "pocket" ? null : BURMESE_SCRIPT_ONLY_ERROR;
  if (scriptLocale === null) return null;
  return validateNarrationLanguage(scriptLocale, narrationLanguageOf(provider));
}

/** A plan source's default runtime mode, or "?" when the plan fails to load. */
function planRuntimeLabelOf(source: StudioLessonSource): string {
  try {
    return sourceRuntimeDefault(source);
  } catch {
    return "?";
  }
}

function readImportedScripts(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(IMPORTED_SCRIPTS_KEY) ?? "{}") as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function storeImportedScript(slug: string, yamlText: string): void {
  try {
    sessionStorage.setItem(
      IMPORTED_SCRIPTS_KEY,
      JSON.stringify({ ...readImportedScripts(), [slug]: yamlText }),
    );
  } catch {
    // Session storage unavailable — the import still works until reload.
  }
}

function allSources(imported: Record<string, string>): Record<string, StudioLessonSource> {
  const importedSources = Object.fromEntries(
    Object.entries(imported).map(([slug, yamlText]) => [
      slug,
      { kind: "script", load: () => parseLessonScriptYaml(yamlText) } satisfies StudioLessonSource,
    ]),
  );
  // Imported scripts shadow checked-in ones of the same slug (iteration flow).
  // Null-prototype so a `?plan=` of `constructor`/`toString`/`__proto__` misses
  // instead of resolving to an inherited member: the callers' falsy guards let
  // one through, and calling `.load()` on it threw during render — outside any
  // try/catch — dropping the whole /studio route into its error boundary.
  return Object.assign(Object.create(null) as Record<string, StudioLessonSource>, {
    ...STUDIO_SOURCES,
    ...importedSources,
  });
}

interface StudioRunEntry {
  index: number;
  mode: StudioRuntimeMode;
  /** The lesson slug this run actually performed — the selection may have moved on since. */
  slug: string;
  /**
   * Identity of the source at render time. An imported script edited between
   * runs (same slug, new YAML) changes this, so a stale bundle is never offered
   * for the newly imported content (STUDIO-02).
   */
  sourceRevision: string;
  /** Human title captured at render time; the draft-upload flow uses THIS, never the current selection. */
  title: string;
  /** Display name of the voice used for this run, or null for the script default. */
  voiceName: string | null;
  /** What `voiceName` names — see DraftProvenanceRun. */
  voiceKind: "cloned" | "reference" | "athanlab" | null;
  /** TTS implementation used to produce this run's narration. */
  narrationProvider: string | null;
  result: StudioRunResult;
}

// Module-level so StrictMode remounts and rerenders never re-trigger or lose
// runs; cleared only by a full page load.
const runHistory: StudioRunEntry[] = [];
let autostartFired = false;

declare global {
  interface Window {
    __NEXT_EDITOR_STUDIO__?: {
      runs: {
        index: number;
        mode: StudioRuntimeMode;
        outcome: string;
        report: StudioRunEntry["result"]["report"];
        manifest: StudioRunEntry["result"]["manifest"];
      }[];
      comparison: StudioCheckResult[] | null;
      running: boolean;
    };
  }
}

function semanticsStorageKey(slug: string, mode: StudioRuntimeMode): string {
  // v2 stores passing renders only; ignore older session entries that may have
  // been written by a failed artifact check and poisoned the next comparison.
  return `next-editor:studio:passed-semantics:v2:${slug}:${mode}`;
}

function readStoredSemantics(slug: string, mode: StudioRuntimeMode): RenderSemantics | null {
  try {
    const raw = sessionStorage.getItem(semanticsStorageKey(slug, mode));
    return raw ? (JSON.parse(raw) as RenderSemantics) : null;
  } catch {
    return null;
  }
}

function storeSemantics(slug: string, mode: StudioRuntimeMode, semantics: RenderSemantics): void {
  try {
    sessionStorage.setItem(semanticsStorageKey(slug, mode), JSON.stringify(semantics));
  } catch {
    // Session storage unavailable — cross-reload comparison is best-effort.
  }
}

/**
 * Whether a narrator reference can condition Burmese VoxCPM2 narration: long enough
 * to keep one speaker, and within the stored-sample limit.
 */
function isBurmeseReferenceReady(voice: SavedCustomVoice): boolean {
  const durationSeconds = voice.samples.length / voice.sampleRate;
  return durationSeconds >= MIN_VOXCPM2_REFERENCE_SECONDS && durationSeconds <= MAX_SAMPLE_SECONDS;
}

function publishWindowHandle(comparison: StudioCheckResult[] | null, running: boolean): void {
  window.__NEXT_EDITOR_STUDIO__ = {
    runs: runHistory.map((entry) => ({
      index: entry.index,
      mode: entry.mode,
      outcome: entry.result.report.outcome,
      report: entry.result.report,
      manifest: entry.result.manifest,
    })),
    comparison,
    running,
  };
}

export default function StudioController() {
  const [searchParams, setSearchParams] = useSearchParams();
  const actor = NextEditorActorContext.useActorRef();
  const nextEditor = useNextEditorActions();
  const workspace = useWorkspaceActions();
  const { store: runtimePanelStore } = useRuntimePanelStore();
  const { store: slidesStore } = useSlidesStore();
  const { store: whiteboardStore } = useWhiteboardStore();
  const webContainerRuntimeActions = useWebContainerRuntimeActions();
  const webContainerRuntimeMetadata = useWebContainerRuntimeMetadata();
  const getWebContainerRuntimeSnapshot = useWebContainerRuntimeSnapshotGetter();
  const previewPanel = usePreviewPanel();
  const previewHandle = usePreviewAdapterHandle();
  const { user, isLoading: authLoading } = useAuth();
  const userId = user?.id ?? null;
  const { capabilities: studioCapabilities, isLoading: studioCapabilitiesLoading } =
    useStudioCapabilities(userId);
  const queryClient = useQueryClient();
  const webContainerRuntimeActionsRef = useRef(webContainerRuntimeActions);
  const webContainerRuntimeMetadataRef = useRef(webContainerRuntimeMetadata);

  useLayoutEffect(() => {
    webContainerRuntimeActionsRef.current = webContainerRuntimeActions;
    webContainerRuntimeMetadataRef.current = webContainerRuntimeMetadata;
  }, [webContainerRuntimeActions, webContainerRuntimeMetadata]);

  const planSlug = searchParams.get("plan") ?? DEFAULT_STUDIO_PLAN_SLUG;
  // Parse both documented values (fixture | live) explicitly; an unrecognized
  // value is surfaced below rather than silently coerced to the plan default,
  // which could otherwise force a live-default plan onto the real service even
  // when the caller asked for fixture (STUDIO-05).
  const runtimeModeParam = parseRuntimeModeParam(searchParams.get("runtime"));
  const requestedMode = runtimeModeParam.mode;
  const autostart = shouldAutostartRender(
    searchParams.get("autostart"),
    typeof navigator !== "undefined" && navigator.webdriver === true,
  );

  const [phase, setPhase] = useState<string>("idle");
  const [running, setRunning] = useState(false);
  const [receipts, setReceipts] = useState<ActionReceipt[]>([]);
  const [latest, setLatest] = useState<StudioRunEntry | null>(runHistory.at(-1) ?? null);
  const [comparison, setComparison] = useState<StudioCheckResult[] | null>(null);
  const [baselineNote, setBaselineNote] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [buildWarnings, setBuildWarnings] = useState<string[]>([]);
  const [criticNotes, setCriticNotes] = useState<CritiqueNote[]>([]);
  const [importedScripts, setImportedScripts] = useState<Record<string, string>>(() =>
    readImportedScripts(),
  );
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [provider, setProvider] = useState<StudioNarrationProvider>(readStoredNarrationProvider);
  // Reported by <AthanLabPanel>: the voice every dialog is synthesized with,
  // and whether a render can start (key connected, voice chosen, balance left).
  const [athanLabVoice, setAthanLabVoice] = useState<{ id: string; name: string } | null>(null);
  const [athanLabReadiness, setAthanLabReadiness] = useState<{
    ready: boolean;
    reason: string | null;
  }>(ATHANLAB_NOT_REPORTED);
  const runningRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // The draft modal replaces the whole console (see the early return below), so
  // its "Create draft…" trigger unmounts while it is open. Closing it puts focus
  // back on the re-mounted trigger instead of leaving it on <body>.
  const draftButtonRef = useRef<HTMLButtonElement | null>(null);
  const restoreDraftFocusRef = useRef(false);
  useEffect(() => {
    if (!showDraftModal && restoreDraftFocusRef.current) {
      restoreDraftFocusRef.current = false;
      draftButtonRef.current?.focus();
    }
  }, [showDraftModal]);

  // Opt-in screen recording: capture the performance to a standalone local video
  // (narration muxed in via tab audio) alongside the .ne bundle. Reuses the shared
  // recording-settings toggle and the same capture path as the manual record button.
  const { screenRecordingEnabled } = useRecordingSettings();
  const recordingSettingsTrigger = useRecordingSettingsTrigger();
  const [isScreenSupported, setIsScreenSupported] = useState(false);
  useEffect(() => {
    setIsScreenSupported(isScreenCaptureSupported());
  }, []);

  // Narrator references live in this browser's IndexedDB. The selected sample
  // either clones Pocket-TTS locally or conditions Burmese VoxCPM2 through the
  // authenticated Worker at render time.
  const [customVoices, setCustomVoices] = useState<SavedCustomVoice[]>([]);
  const [voiceChoice, setVoiceChoice] = useState<string>(
    () => readStoredPreference(VOICE_CHOICE_KEY) ?? "default",
  );
  const [voiceBusy, setVoiceBusy] = useState<string | null>(null);
  const voiceFileInputRef = useRef<HTMLInputElement | null>(null);
  const voiceSelectRef = useRef<HTMLSelectElement | null>(null);
  const voiceRecorderRef = useRef<{ recorder: MediaRecorder; chunks: Blob[] } | null>(null);
  const [voiceRecording, setVoiceRecording] = useState(false);

  const chooseProvider = (next: StudioNarrationProvider) => {
    if (next === provider) return;
    setProvider(next);
    storeNarrationProvider(next);
    // A remounting panel reports afresh; never start from its previous answer.
    if (next === "athanlab") setAthanLabReadiness(ATHANLAB_NOT_REPORTED);
    // A completed bundle belongs to the provider that synthesized it — also
    // across the two Burmese providers. Do not leave that artifact exposed
    // after the provider selection changes.
    setLatest(null);
    setComparison(null);
    setBaselineNote(null);
    setReceipts([]);
    setFatal(null);
  };

  // VoxCPM2 is enabled per user; fall back to English when it is not (once the
  // session is known — signed-out-while-loading would otherwise reset it on
  // every page load). The stored choice is left alone so it returns when the
  // flag does. AthanLab is never reset here: its panel explains what is missing.
  useEffect(() => {
    if (
      !authLoading &&
      !studioCapabilitiesLoading &&
      !studioCapabilities.burmeseVoxCpm2 &&
      provider === "voxcpm2"
    ) {
      setProvider("pocket");
      setLatest(null);
      setComparison(null);
    }
  }, [authLoading, provider, studioCapabilities.burmeseVoxCpm2, studioCapabilitiesLoading]);

  const reportAthanLabVoice = (voiceId: string | null, voiceName: string | null) => {
    setAthanLabVoice((current) => {
      if (voiceId === null) return null;
      if (current?.id === voiceId && current.name === voiceName) return current;
      return { id: voiceId, name: voiceName ?? voiceId };
    });
  };

  const reportAthanLabReadiness = (ready: boolean, reason: string | null) => {
    setAthanLabReadiness((current) =>
      current.ready === ready && current.reason === reason ? current : { ready, reason },
    );
  };

  useEffect(() => {
    void listCustomVoices().then(setCustomVoices);
  }, []);

  const selectedVoice = customVoices.find((voice) => voice.id === voiceChoice) ?? null;
  const selectedVoiceIsBurmeseReady =
    selectedVoice !== null && isBurmeseReferenceReady(selectedVoice);
  const requiredVoiceSeconds =
    provider === "voxcpm2" ? MIN_VOXCPM2_REFERENCE_SECONDS : MIN_SAMPLE_SECONDS;

  const chooseVoice = (value: string) => {
    setVoiceChoice(value);
    writeStoredPreference(VOICE_CHOICE_KEY, value);
  };

  const saveVoiceFromAudio = async (bytes: ArrayBuffer, suggestedName: string) => {
    setVoiceBusy("Preparing the sample (24 kHz mono)…");
    try {
      const samples = await prepareVoiceSample(bytes);
      if (
        provider === "voxcpm2" &&
        samples.length < MIN_VOXCPM2_REFERENCE_SECONDS * VOICE_SAMPLE_RATE
      ) {
        throw new Error(
          `Burmese narration requires at least ${MIN_VOXCPM2_REFERENCE_SECONDS}s of clear reference speech`,
        );
      }
      const voice = await saveCustomVoice(suggestedName, samples);
      setCustomVoices(await listCustomVoices());
      chooseVoice(voice.id);
    } finally {
      setVoiceBusy(null);
    }
  };

  const handleVoiceFile = async (file: File) => {
    try {
      await saveVoiceFromAudio(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ""));
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleVoiceRecording = async () => {
    const active = voiceRecorderRef.current;
    if (active) {
      active.recorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        voiceRecorderRef.current = null;
        setVoiceRecording(false);
        for (const track of stream.getTracks()) track.stop();
        void new Blob(chunks, { type: recorder.mimeType })
          .arrayBuffer()
          .then((bytes) => saveVoiceFromAudio(bytes, "My voice"))
          .catch((error: unknown) =>
            setFatal(error instanceof Error ? error.message : String(error)),
          );
      };
      voiceRecorderRef.current = { recorder, chunks };
      setVoiceRecording(true);
      recorder.start();
      // The engine conditions on at most 20s — stop the mic there.
      setTimeout(() => {
        if (voiceRecorderRef.current?.recorder === recorder && recorder.state === "recording") {
          recorder.stop();
        }
      }, 20_000);
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    }
  };

  const previewVoice = async () => {
    if (!selectedVoice) return;
    setVoiceBusy(`Synthesizing a preview with "${selectedVoice.name}"…`);
    try {
      const wav =
        provider === "voxcpm2"
          ? await synthesizeModalVoxCpm2Wav(
              modalVoxCpm2BurmeseProfileOf(selectedVoice),
              "မင်္ဂလာပါ။ ဒီအသံနဲ့ သင်ခန်းစာတစ်လျှောက် တစ်သမတ်တည်း ရှင်းပြပေးပါမယ်။",
              1,
            )
          : await synthesizePocketWav(
              customVoiceProfileOf(selectedVoice),
              "Hi! This is my cloned voice, reading a quick preview.",
              1,
            );
      const url = URL.createObjectURL(new Blob([wav.slice() as BlobPart], { type: "audio/wav" }));
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (error) {
      setFatal(error instanceof Error ? error.message : String(error));
    } finally {
      setVoiceBusy(null);
    }
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

  // Memoized (this module is uncompiled) so `sources[planSlug]` keeps its
  // identity across the per-receipt/phase/output-chunk re-renders, which lets
  // the runtime label below skip re-parsing the lesson YAML each time.
  const sources = useMemo(() => allSources(importedScripts), [importedScripts]);

  const selectLesson = (slug: string) => {
    if (slug !== planSlug) {
      // Moving to a different lesson: drop the previous run's transient verdicts
      // so nothing stale lingers beside the new selection (STUDIO-02). The
      // completed run stays in history; its bundle/report reappear on reselect.
      setComparison(null);
      setBaselineNote(null);
      setReceipts([]);
      setFatal(null);
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("plan", slug);
        return next;
      },
      { replace: true },
    );
  };

  const handleImportFile = async (file: File) => {
    setFatal(null);
    setCriticNotes([]);
    try {
      const yamlText = await file.text();
      // Same validation the render path runs — fail here with the schema
      // message rather than at render time.
      const script = parseLessonScriptYaml(yamlText);
      const extracted = extractScriptNarration(script);
      const critique = critiqueScript(script, extracted);
      setCriticNotes(critique.notes);

      const slug = script.lesson.slug;
      storeImportedScript(slug, yamlText);
      setImportedScripts((current) => ({ ...current, [slug]: yamlText }));
      selectLesson(slug);
    } catch (error) {
      setFatal(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // The product tour would overlay the editor mid-render in a fresh profile.
  useEffect(() => {
    markTourSeen();
  }, []);

  const runRender = async () => {
    if (runningRef.current) {
      return;
    }
    runningRef.current = true;
    // Captured once: the provider select is disabled while rendering, but the
    // finally below must refresh the account this render actually used.
    const renderProvider = provider;
    // The report's wall time covers synthesis and compilation, not just the performance.
    const startedAt = { iso: new Date().toISOString(), performanceNowMs: performance.now() };
    setRunning(true);
    setFatal(null);
    setReceipts([]);
    setComparison(null);
    setBaselineNote(null);
    // Clear the previous run's bundle/report the moment a new render starts, so a
    // pre-render failure (e.g. a plan-build throw, which never reaches setLatest)
    // can't leave a stale passing artifact sitting beside the new error (STUDIO-02).
    setLatest(null);
    publishWindowHandle(null, true);

    // Hoisted so the catch can release the display stream if the render throws
    // before the recorder machine takes ownership of it (e.g. plan build fails).
    let acquiredScreenStream: MediaStream | undefined;

    try {
      const source = sources[planSlug];
      if (!source) {
        throw new Error(
          `Unknown lesson "${planSlug}" — available: ${Object.keys(sources).join(", ")}`,
        );
      }
      // Everything checkable without a network round trip — the script's
      // locale against the provider, the provider's own requirements — fails
      // here, before the screen picker below opens for a render that cannot run.
      const script = source.kind === "script" ? source.load() : null;
      if (!script && renderProvider !== "pocket") {
        throw new Error(BURMESE_SCRIPT_ONLY_ERROR);
      }
      const renderVoice = customVoices.find((voice) => voice.id === voiceChoice) ?? null;
      let voiceProfile: VoiceProfile | undefined;
      let voiceName: string | null = null;
      let voiceKind: StudioRunEntry["voiceKind"] = null;
      if (script) {
        const languageError = validateNarrationLanguage(
          script.lesson.locale,
          narrationLanguageOf(renderProvider),
        );
        if (languageError) throw new Error(languageError);

        if (renderProvider === "voxcpm2") {
          if (!studioCapabilities.burmeseVoxCpm2) {
            throw new Error("Burmese · VoxCPM2 (Modal) is not enabled for this user");
          }
          if (!renderVoice || !isBurmeseReferenceReady(renderVoice)) {
            throw new Error(
              `Burmese narration requires a ${MIN_VOXCPM2_REFERENCE_SECONDS}–${MAX_SAMPLE_SECONDS}s narrator reference. Record or upload one first.`,
            );
          }
          voiceProfile = modalVoxCpm2BurmeseProfileOf(renderVoice);
          voiceName = renderVoice.name;
          voiceKind = "reference";
        } else if (renderProvider === "athanlab") {
          if (!studioCapabilities.athanlab) {
            throw new Error("AthanLab narration is not available on this server yet");
          }
          if (!athanLabReadiness.ready || !athanLabVoice) {
            throw new Error(athanLabReadiness.reason ?? "Choose an AthanLab voice first");
          }
          voiceProfile = athanLabProfileOf(athanLabVoice.id);
          voiceName = athanLabVoice.name;
          voiceKind = "athanlab";
        } else if (renderVoice) {
          voiceProfile = customVoiceProfileOf(renderVoice);
          voiceName = renderVoice.name;
          voiceKind = "cloned";
        }
      }

      // Script sources run the in-page Director first: per-dialog synthesis
      // (cached; seeded where the provider allows), joint scheduling,
      // stitching, compilation.
      let plan: StudioPlan;
      let narrationProvider: string | null = null;
      const renderOptions: StudioRenderOptions = { startedAt };
      setBuildWarnings([]);

      // Opt-in screen capture must be acquired here — the FIRST await in the
      // click handler — while the Start-render click's transient user activation
      // is still valid (getDisplayMedia consumes it, and the plan build below is
      // slow). A dismissed picker or a non-gesture autostart run rejects here;
      // that is non-fatal — the .ne bundle is the primary artifact, so render on
      // without the video. The recorder machine owns the stream from here and
      // saves the video via onScreenRecordingReady (saveScreenRecordingLocally).
      if (screenRecordingEnabled && isScreenSupported) {
        try {
          acquiredScreenStream = await acquireDisplayStream(true);
          renderOptions.screenStream = acquiredScreenStream;
        } catch (error) {
          console.warn("Studio screen capture not started; rendering without it:", error);
        }
      }

      if (source.kind === "plan") {
        plan = source.load();
      } else {
        // `script` is this source, already parsed and checked above.
        const built = await buildPlanFromScript(script ?? source.load(), {
          onPhase: setPhase,
          voiceProfile,
        });
        narrationProvider = narrationProviderLabel(renderProvider);
        plan = built.plan;
        renderOptions.narration = built.narration;
        setBuildWarnings(built.warnings);
      }
      const mode: StudioRuntimeMode = requestedMode ?? defaultRuntimeModeOf(plan.runtime);

      const result = await runStudioRender(
        plan,
        mode,
        {
          actor,
          nextEditor,
          getEditor: () => nextEditor.editorRef.current,
          workspace,
          runtimePanelStore,
          slidesStore,
          whiteboardStore,
          webContainerRuntime: {
            getActions: () => webContainerRuntimeActionsRef.current,
            getMetadata: () => webContainerRuntimeMetadataRef.current,
            getSnapshot: getWebContainerRuntimeSnapshot,
          },
          preview: {
            open: (mode) => previewPanel.openPreview(mode),
            close: previewPanel.closePreview,
            getState: () => previewHandle.snapshotGetter.current?.() ?? null,
            executeCommand: (command, options) => {
              const executor = previewHandle.previewCommandExecutor.current;
              if (!executor) {
                return Promise.reject(new Error("The live preview command bridge is not mounted"));
              }
              return executor(command, options);
            },
            captureScreenshot: () => {
              const capture = previewHandle.previewScreenshotCapturer.current;
              if (!capture) {
                return Promise.reject(
                  new Error("The live preview screenshot bridge is not mounted"),
                );
              }
              return capture();
            },
          },
          onPhase: setPhase,
          onProgress: (receipt) => setReceipts((current) => [...current, receipt]),
        },
        renderOptions,
      );

      const entry: StudioRunEntry = {
        index: runHistory.length + 1,
        mode,
        slug: plan.lesson.slug,
        sourceRevision: sourceRevisionOf(planSlug, importedScripts),
        title: script?.lesson.title ?? plan.lesson.title,
        voiceName,
        voiceKind,
        narrationProvider,
        result,
      };
      runHistory.push(entry);
      setLatest(entry);

      let nextComparison: StudioCheckResult[] | null = null;
      // A failed artifact may still have extractable diagnostics, but it is not
      // a repeatability baseline and must never overwrite the last passing one.
      if (result.semantics && result.report.outcome === "passed") {
        // Baseline selection and the same-plan rule (STUDIO-04) live in checkRepeatability.
        const repeatability = checkRepeatability(
          runHistory.slice(0, -1).map((run) => ({
            mode: run.mode,
            outcome: run.result.report.outcome,
            semantics: run.result.semantics,
          })),
          mode,
          result.semantics,
          readStoredSemantics(plan.lesson.slug, mode),
        );
        nextComparison = repeatability.comparison;
        setComparison(repeatability.comparison);
        setBaselineNote(repeatability.baselineNote);
        storeSemantics(plan.lesson.slug, mode, result.semantics);
      }
      publishWindowHandle(nextComparison, false);
      setPhase(result.report.outcome === "passed" ? "done" : "failed");
    } catch (error) {
      // A throw before startRecording (e.g. plan-build failure) means the
      // recorder never took the display stream — release it so the browser's
      // capture indicator clears. After handoff the machine owns and stops it;
      // stopping already-ended tracks here is a harmless no-op.
      for (const track of acquiredScreenStream?.getTracks() ?? []) {
        track.stop();
      }
      setFatal(error instanceof Error ? error.message : String(error));
      setPhase("failed");
      publishWindowHandle(null, false);
    } finally {
      runningRef.current = false;
      setRunning(false);
      // The render spent AthanLab characters (refresh the balance), or AthanLab
      // refused the saved key — re-reading the key flips the panel to its
      // connect form.
      if (renderProvider === "athanlab" && userId !== null) {
        void invalidateAthanLabAccount(queryClient, userId);
      }
    }
  };

  useEffect(() => {
    publishWindowHandle(comparison, runningRef.current);
  }, [comparison, latest]);

  // One-shot per page load (module flag): StrictMode remounts and later
  // re-renders must not restart an unattended render. `autostart` is already
  // false outside an automation-controlled browser (shouldAutostartRender).
  useEffect(() => {
    if (!autostart || autostartFired) {
      return;
    }
    autostartFired = true;
    void runRender();
  }, [autostart, runRender]);

  const source = sources[planSlug];
  // A completed run's bundle/report/draft are exposed only while the current
  // selection still matches the run that produced them and nothing is rendering.
  // This is what stops a run of lesson A being downloaded or drafted under the
  // metadata of a since-selected lesson B (STUDIO-02).
  const latestMatchesSelection = runExposedForSelection(
    latest,
    planSlug,
    sourceRevisionOf(planSlug, importedScripts),
    running,
  );
  const activeRun = latestMatchesSelection ? latest : null;
  const report = activeRun?.result.report ?? null;
  const artifacts = activeRun?.result.artifacts ?? null;
  // Parsing validates the whole YAML (5–14 ms per call), so it runs once per
  // selection or import, not on every receipt/phase re-render. An imported
  // script re-parsed against a since-tightened schema can fail here: that
  // yields null (the label reads "?") instead of a throw during render, which
  // would drop the route into its error boundary; Start render parses again
  // and reports the schema error.
  const selectedScript = useMemo(() => {
    if (source?.kind !== "script") return null;
    try {
      return source.load();
    } catch {
      return null;
    }
  }, [source]);
  const selectedScriptLocale = selectedScript?.lesson.locale ?? null;
  const effectiveModeLabel =
    requestedMode ??
    (selectedScript
      ? defaultRuntimeModeOf(selectedScript.runtime)
      : source?.kind === "plan"
        ? planRuntimeLabelOf(source)
        : "?");
  // Disables Start render with its reason, so a locale/provider mismatch is
  // caught before the screen picker opens (runRender checks again).
  const narrationSetupError = narrationSetupErrorOf(source, selectedScriptLocale, provider);
  const startBlockedReason =
    narrationSetupError ??
    (provider === "athanlab" && !athanLabReadiness.ready
      ? (athanLabReadiness.reason ?? ATHANLAB_NOT_REPORTED.reason)
      : null);

  const downloadBundle = () => {
    if (!activeRun || !artifacts) {
      return;
    }
    const base = `lesson-${activeRun.result.report.planSlug}`;
    downloadBlob(artifacts.neBlob, `${base}.ne`);
    downloadBlob(artifacts.audioBlob, artifacts.audioFileName || `${base}.m4a`);
    downloadBlob(
      new Blob([canonicalJson(activeRun.result.manifest)], { type: "application/json" }),
      "build-manifest.json",
    );
    downloadBlob(
      new Blob([JSON.stringify(activeRun.result.report, null, 2)], { type: "application/json" }),
      "render-report.json",
    );
  };

  const downloadReport = () => {
    if (!activeRun) {
      return;
    }
    downloadBlob(
      new Blob([JSON.stringify(activeRun.result.report, null, 2)], { type: "application/json" }),
      "render-report.json",
    );
  };

  // One surface at a time: while the draft upload is open, the render console
  // steps aside entirely instead of stacking a modal on top of a panel.
  if (showDraftModal && artifacts && activeRun) {
    // The standard authenticated upload flow: R2 media + a D1 draft row.
    // Publishing remains a separate owner action in the lessons UI
    // (docs/agent-lesson-production.md §10). The description pre-fills only
    // public-safe text (title + AI-narration disclosure): it becomes the
    // published page's meta description, so the build provenance and review
    // reminder stay on the "Create draft…" button instead. Every field
    // is read off the completed run entry — never the live selection — so the
    // recording, title, and voice always describe the same render (STUDIO-02).
    return (
      <UploadLessonModal
        recording={artifacts.recording}
        onClose={() => {
          restoreDraftFocusRef.current = true;
          setShowDraftModal(false);
        }}
        initialTitle={activeRun.title}
        initialDescription={describeDraftDescription(activeRun)}
        initialTags="studio, ai-produced"
      />
    );
  }

  // Collapsing keeps the header (status badge + toggle) right-anchored where it
  // was, so the toggle stays under the pointer and the preview behind the
  // panel is uncovered mid-render. The body stays mounted, only hidden.
  return (
    <div
      className={`fixed right-3 top-14 z-70 rounded-xl border border-slate-700 bg-[#0d1117]/95 text-slate-200 shadow-2xl backdrop-blur text-[13px] leading-5 ${
        collapsed
          ? "py-2 pl-3 pr-2"
          : "w-96 max-w-[calc(100vw-1.5rem)] max-h-[75vh] overflow-y-auto p-4"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-white">Studio render</h2>
        <div className="flex items-center gap-1.5">
          {/* The status region lives in the header, outside the hidden body, so
              a render's progress and outcome are announced while collapsed. */}
          <span
            role="status"
            className={`rounded px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
              phase === "done"
                ? "bg-emerald-500/15 text-emerald-300"
                : phase === "failed"
                  ? "bg-rose-500/15 text-rose-300"
                  : running
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-slate-500/15 text-slate-300"
            }`}
          >
            <span className="sr-only">Render status: </span>
            {running ? phase : phase === "idle" ? "ready" : phase}
          </span>
          <button
            type="button"
            // Keep focus where it is: the performer drives a focused editor, and
            // a toggle click mid-render must not blur it on screen.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setCollapsed((current) => !current)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand studio render panel" : "Collapse studio render panel"}
            title={collapsed ? "Show the render console" : "Hide the render console"}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-[#222d3b] hover:text-slate-100"
          >
            {collapsed ? (
              <ChevronDown aria-hidden="true" className="size-4" />
            ) : (
              <ChevronUp aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
      </div>

      <div hidden={collapsed}>
        <div className="mt-2 flex items-center gap-2">
          <select
            value={planSlug}
            disabled={running}
            onChange={(event) => selectLesson(event.target.value)}
            aria-label="Lesson to render"
            className="min-w-0 flex-1 rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50"
          >
            {Object.keys(sources)
              .sort()
              .map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                  {importedScripts[slug] ? " (imported)" : ""}
                </option>
              ))}
          </select>
          <button
            type="button"
            disabled={running}
            onClick={() => importInputRef.current?.click()}
            className="shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
            title="Import a LessonScript YAML (validated and critiqued here in the page)"
          >
            Import…
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".yaml,.yml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) {
                void handleImportFile(file);
              }
            }}
          />
        </div>

        <div className="mt-2">
          <select
            value={provider}
            disabled={running || studioCapabilitiesLoading || voiceBusy !== null || voiceRecording}
            onChange={(event) => {
              if (isStudioNarrationProvider(event.target.value)) {
                chooseProvider(event.target.value);
              }
            }}
            aria-label="Narration language and provider"
            className="w-full rounded-md border border-slate-500 bg-[#151a22] px-2 py-1.5 font-mono text-[12px] text-slate-200 disabled:opacity-50"
          >
            <option value="pocket">English · Pocket-TTS</option>
            <option value="athanlab">မြန်မာ · AthanLab (your API key)</option>
            {studioCapabilities.burmeseVoxCpm2 ? (
              <option value="voxcpm2">မြန်မာ · VoxCPM2 (Modal)</option>
            ) : null}
          </select>
        </div>

        {provider === "athanlab" ? (
          <AthanLabPanel
            userId={userId}
            capabilityAvailable={studioCapabilities.athanlab}
            capabilitiesLoading={authLoading || studioCapabilitiesLoading}
            disabled={running || voiceBusy !== null}
            onVoiceChange={reportAthanLabVoice}
            onReadyChange={reportAthanLabReadiness}
          />
        ) : null}

        {/* AthanLab voices come from the user's AthanLab account (the panel
            above); the browser-local clone/reference voices are for the others. */}
        {provider === "athanlab" ? null : (
          <div className="mt-2 flex items-center gap-2">
            <select
              ref={voiceSelectRef}
              value={selectedVoice ? selectedVoice.id : "default"}
              disabled={running || voiceBusy !== null}
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
              disabled={running || voiceBusy !== null || voiceRecording}
              onClick={() => voiceFileInputRef.current?.click()}
              className="shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
              title={`Upload ${requiredVoiceSeconds}–${MAX_SAMPLE_SECONDS}s of clear narrator speech`}
            >
              {provider === "voxcpm2" ? "Reference…" : "Clone…"}
            </button>
            <button
              type="button"
              disabled={running || voiceBusy !== null}
              onClick={() => {
                void toggleVoiceRecording();
              }}
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
                    running ||
                    voiceBusy !== null ||
                    voiceRecording ||
                    (provider === "voxcpm2" && !selectedVoiceIsBurmeseReady)
                  }
                  onClick={() => {
                    void previewVoice();
                  }}
                  className="shrink-0 rounded-md bg-[#222d3b] px-2.5 py-1.5 text-[12px] font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
                  title="Synthesize a short preview sentence with this voice"
                >
                  Preview
                </button>
                <button
                  type="button"
                  disabled={running || voiceBusy !== null || voiceRecording}
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
                  void handleVoiceFile(file);
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
              Recording… speak naturally for at least {requiredVoiceSeconds}s; stops automatically
              at {MAX_SAMPLE_SECONDS}s.
            </p>
          ) : null}
        </div>
        {provider === "voxcpm2" ? (
          <p
            className={`mt-1 text-[12px] ${
              selectedVoiceIsBurmeseReady ? "text-slate-400" : "text-amber-300"
            }`}
          >
            A {MIN_VOXCPM2_REFERENCE_SECONDS}–{MAX_SAMPLE_SECONDS}s narrator reference is required
            so every dialog keeps the same character. The selected sample goes to your private Modal
            deployment with each narration job, along with the fixed Burmese educator prompt. Modal
            stores each job's input and keeps its audio for up to 7 days. The LessonScript must use{" "}
            <span className="font-mono text-slate-300">locale: my-MM</span>.
          </p>
        ) : null}

        <label
          className={`mt-2 flex items-center gap-2 text-[12px] ${
            isScreenSupported ? "text-slate-300" : "text-slate-500"
          }`}
          title={
            isScreenSupported
              ? 'Also capture this render as a screen recording — a video downloaded alongside the bundle (saved locally, never uploaded). You\'ll pick a screen or tab when the render starts. Narration is captured only when you share a browser tab with "share tab audio" on; sharing a screen or window records a silent video (saved as "…-silent").'
              : "Screen recording needs a desktop browser with screen capture (getDisplayMedia)."
          }
        >
          <input
            type="checkbox"
            checked={screenRecordingEnabled && isScreenSupported}
            disabled={running || !isScreenSupported}
            onChange={(event) =>
              recordingSettingsTrigger.setScreenRecordingEnabled({ enabled: event.target.checked })
            }
            className="size-3.5 accent-sky-500 disabled:opacity-50"
          />
          Screen recording
          <span className="text-slate-400">
            {isScreenSupported ? "— saved locally as video" : "— unavailable on this browser"}
          </span>
        </label>

        <p className="mt-1 text-slate-400">
          runtime <span className="font-mono text-slate-300">{effectiveModeLabel}</span>
          {" · run #"}
          {runHistory.length + (running ? 1 : 0) || 1}
        </p>

        {runtimeModeParam.invalid ? (
          <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[12px] text-amber-200">
            Ignoring <span className="font-mono">runtime={runtimeModeParam.raw}</span> — expected{" "}
            <span className="font-mono">fixture</span> or <span className="font-mono">live</span>.
            Using the plan default (<span className="font-mono">{effectiveModeLabel}</span>).
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void runRender();
            }}
            disabled={
              running ||
              voiceBusy !== null ||
              voiceRecording ||
              (provider === "voxcpm2" && !selectedVoiceIsBurmeseReady) ||
              startBlockedReason !== null
            }
            aria-describedby={
              startBlockedReason && !running ? "studio-start-blocked-reason" : undefined
            }
            className="rounded-md bg-[#173925] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {runHistory.length === 0 ? "Start render" : "Render again"}
          </button>
          <button
            type="button"
            onClick={downloadBundle}
            disabled={!artifacts}
            className="rounded-md bg-[#222d3b] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#8db8ef] transition-colors hover:bg-[#2a3a4d] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Download bundle
          </button>
          {report && !artifacts ? (
            <button
              type="button"
              onClick={downloadReport}
              className="rounded-md bg-[#3b2a22] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#efb28d] transition-colors hover:bg-[#4d382a]"
            >
              Download report
            </button>
          ) : null}
          {artifacts ? (
            <button
              ref={draftButtonRef}
              type="button"
              onClick={() => setShowDraftModal(true)}
              className="rounded-md bg-[#2b2340] px-3 py-1.5 font-bold uppercase tracking-[0.04em] text-[#c4b0f5] transition-colors hover:bg-[#382e52]"
              title={`Upload through the standard lesson flow — creates a draft only; publishing stays a separate human action.${
                activeRun ? ` ${describeDraftProvenance(activeRun)}` : ""
              }`}
            >
              Create draft…
            </button>
          ) : null}
        </div>

        {/* Describes the disabled Start button. Not a live region: for AthanLab
            it repeats the panel's own message, which would be announced twice. */}
        {startBlockedReason && !running ? (
          <p id="studio-start-blocked-reason" className="mt-2 text-[12px] text-amber-300">
            {startBlockedReason}
          </p>
        ) : null}

        {fatal ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-rose-200"
          >
            {fatal}
          </p>
        ) : null}

        {buildWarnings.length > 0 ? (
          <ul className="mt-3 space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-[12px] text-amber-200">
            {buildWarnings.map((warning) => (
              <li key={warning}>⚠ {warning}</li>
            ))}
          </ul>
        ) : null}

        {criticNotes.length > 0 ? (
          <div className="mt-3 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2 text-[12px] text-sky-200">
            <p className="font-semibold">Critic notes (advisory)</p>
            <ul className="mt-1 space-y-0.5">
              {criticNotes.map((note) => (
                <li key={`${note.id}-${note.sceneId ?? ""}-${note.message}`}>✎ {note.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {receipts.length > 0 ? <ReceiptList receipts={receipts} /> : null}

        {report ? <CheckList report={report} /> : null}

        {baselineNote ? <p className="mt-3 text-[12px] text-amber-300">{baselineNote}</p> : null}

        {comparison ? <RepeatabilityVerdict checks={comparison} /> : null}
      </div>
    </div>
  );
}
