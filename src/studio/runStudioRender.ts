import type { Recording } from "../core/src";
import type { EditorActorRef } from "../core/src/useNextEditor";
import type { NextEditorActions } from "../contexts/NextEditorContext";
import type { WorkspaceActions } from "../contexts/WorkspaceContext";
import type { RuntimePanelStoreInstance } from "../stores/runtimePanelStore";
import type { SlidesStoreInstance } from "../stores/slidesStore";
import type { WhiteboardStoreInstance } from "../stores/whiteboardStore";
import { EMPTY_WHITEBOARD_SCENE } from "../core/src/whiteboard";
import { buildRecordingFiles } from "../storage/RecordingStorage";
import { collectWorkspaceFolders, type WorkspaceProject } from "../types/workspace";
import { createWorkspaceFile } from "../starters/shared";
import { workspacePathFromMonacoModelUri } from "../monaco";
import { compareRenderSemantics, extractRenderSemantics, type RenderSemantics } from "./compare";
import { StudioActionError, waitUntil } from "./async";
import { createStudioDriver, type StudioDriverDeps } from "./driver";
import { sha256Hex, sha256HexOfJson, hashWorkspaceFiles } from "./hash";
import type { StudioPlan, StudioRuntimeMode } from "./plan";
import { performPlan } from "./performer";
import { runArtifactChecks, finalWorkspaceHashOf } from "./qa";
import {
  computeTimingStats,
  timingGateCheck,
  type ActionReceipt,
  type StudioBuildManifest,
  type StudioCheckResult,
  type StudioRenderReport,
} from "./report";

/**
 * One end-to-end studio render (docs/agent-lesson-production.md §4.1): pin the
 * workspace, start the recorder with the pre-generated narration, perform the
 * compiled plan, wait for the audio-driven finalize, attach captions, encode
 * the bundle, and run the mechanical QA gates. Fails closed: any perform or
 * gate failure stops the performance, keeps the diagnostic report, and never
 * yields a downloadable lesson bundle.
 */

export interface StudioRunDeps {
  actor: EditorActorRef;
  nextEditor: Pick<
    NextEditorActions,
    | "startRecording"
    | "stopRecording"
    | "clearRecording"
    | "addCaptionTrack"
    | "handleWorkspaceEvent"
    | "handleSlideEvent"
    | "handleWhiteboardEvent"
  >;
  getEditor: StudioDriverDeps["getEditor"];
  workspace: Pick<WorkspaceActions, "getFile" | "getProject" | "setActiveFilePath" | "loadProject">;
  runtimePanelStore: RuntimePanelStoreInstance;
  slidesStore: SlidesStoreInstance;
  whiteboardStore: WhiteboardStoreInstance;
  webContainerRuntime: StudioDriverDeps["webContainerRuntime"];
  preview: StudioDriverDeps["preview"];
  isSignedIn: boolean;
  onProgress?: (receipt: ActionReceipt) => void;
  onPhase?: (phase: string) => void;
}

export interface StudioRunArtifacts {
  neBlob: Blob;
  audioBlob: Blob;
  audioFileName: string;
  /** The finalized in-memory recording — the draft-upload flow consumes it. */
  recording: Recording;
}

export interface StudioRunResult {
  report: StudioRenderReport;
  manifest: StudioBuildManifest;
  semantics: RenderSemantics | null;
  /** Present only when the render passed every gate. */
  artifacts: StudioRunArtifacts | null;
}

function workspaceProjectFromPlan(plan: StudioPlan): WorkspaceProject {
  const files = Object.fromEntries(
    Object.entries(plan.workspace.files).map(([path, content]) => [
      path,
      createWorkspaceFile(path, content),
    ]),
  );
  return {
    id: `studio-${plan.lesson.slug}`,
    name: plan.workspace.name,
    lessonType: plan.workspace.lessonType,
    entryFilePath: plan.workspace.entryFilePath,
    folders: collectWorkspaceFolders(Object.keys(files)),
    files,
  };
}

const PREPARE_TIMEOUT_MS = 15_000;
const RECORDING_START_TIMEOUT_MS = 8_000;
const FINALIZE_GRACE_MS = 10_000;
/** Max drift tolerated between the fetched audio and the plan's pinned duration. */
const AUDIO_DURATION_TOLERANCE_MS = 1_500;

export interface StudioRenderOptions {
  /**
   * In-memory narration from the in-page Director (per-dialog pocket-tts
   * synthesis). When present the plan's audioPath is not fetched — the studio
   * synthesized these exact bytes for this plan.
   */
  narration?: { blob: Blob; bytes: Uint8Array };
}

export async function runStudioRender(
  plan: StudioPlan,
  runtimeMode: StudioRuntimeMode,
  deps: StudioRunDeps,
  options: StudioRenderOptions = {},
): Promise<StudioRunResult> {
  const startedAtIso = new Date().toISOString();
  const wallStart = performance.now();
  const abortController = new AbortController();
  const signal = abortController.signal;
  const receipts: ActionReceipt[] = [];
  const errors: string[] = [];
  const phase = (name: string) => deps.onPhase?.(name);

  let audioHash: string | null = null;

  const failedResult = async (message: string): Promise<StudioRunResult> => {
    errors.push(message);
    return {
      report: {
        outcome: "failed",
        planSlug: plan.lesson.slug,
        runtimeMode,
        startedAtIso,
        wallDurationMs: Math.round(performance.now() - wallStart),
        recordingDurationMs: null,
        receipts,
        timing: computeTimingStats(receipts),
        checks: [],
        errors,
      },
      manifest: await baseManifest(plan, runtimeMode, audioHash, null),
      semantics: null,
      artifacts: null,
    };
  };

  // ---- Preflight -----------------------------------------------------------
  phase("preflight");
  if (
    runtimeMode === "live" &&
    (plan.runtime.kind === "go-playground" ||
      plan.runtime.kind === "kotlin-playground" ||
      plan.runtime.kind === "rust-playground") &&
    !deps.isSignedIn
  ) {
    return failedResult(
      `Live runtime mode needs a signed-in session for /api/${plan.runtime.kind}; sign in or render with runtime=fixture`,
    );
  }
  if (plan.runtime.kind === "webcontainer" && runtimeMode !== "live") {
    return failedResult('WebContainer Studio renders require runtime mode "live"');
  }

  if (plan.runtime.kind === "webcontainer") {
    const metadata = deps.webContainerRuntime.getMetadata();
    if (!metadata.isSupported) {
      return failedResult(
        "WebContainer Studio renders require a supported, cross-origin-isolated desktop browser",
      );
    }

    phase("prepare-runtime-contract");
    const actions = deps.webContainerRuntime.getActions();
    actions.resetRuntime();
    actions.configureRuntime({
      environmentVariables: plan.runtime.environment,
      runnerConfig: {
        enabled: true,
        runOnStartup: false,
        runOnFileSave: false,
        initCommand: plan.runtime.initCommand,
        runCommand: plan.runtime.runCommand,
      },
    });

    try {
      await waitUntil(
        () => {
          const current = deps.webContainerRuntime.getMetadata();
          return (
            current.runnerConfig.enabled === true &&
            current.runnerConfig.runOnStartup === false &&
            current.runnerConfig.runOnFileSave === false &&
            current.runnerConfig.initCommand === plan.runtime.initCommand &&
            current.runnerConfig.runCommand === plan.runtime.runCommand &&
            Object.keys(current.environmentVariables).length ===
              Object.keys(plan.runtime.environment).length &&
            Object.entries(plan.runtime.environment).every(
              ([key, value]) => current.environmentVariables[key] === value,
            )
          );
        },
        {
          timeoutMs: 2_000,
          signal,
          description: "the pinned WebContainer runner contract to apply",
        },
      );
    } catch (error) {
      return failedResult(error instanceof Error ? error.message : String(error));
    }
  }

  let audioBytes: Uint8Array;
  let audioBlob: Blob;
  if (options.narration) {
    audioBytes = options.narration.bytes;
    audioBlob = options.narration.blob;
  } else {
    try {
      const response = await fetch(plan.narration.audioPath, { signal });
      if (!response.ok) {
        return failedResult(
          `Narration fetch failed: HTTP ${response.status} for ${plan.narration.audioPath}`,
        );
      }
      audioBytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return failedResult(
        `Narration fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    audioBlob = new Blob([audioBytes.slice() as BlobPart], {
      type: plan.narration.mimeType,
    });
  }
  audioHash = await sha256Hex(audioBytes);

  // ---- Pin the workspace + surface assets ----------------------------------
  phase("prepare-workspace");
  deps.nextEditor.clearRecording();
  deps.preview.close();
  deps.workspace.loadProject(workspaceProjectFromPlan(plan), plan.workspace.entryFilePath);
  // Slides/whiteboard start from a clean, closed state holding exactly the
  // plan's pinned assets — repeat renders must not inherit the previous run's.
  deps.slidesStore.trigger.setSlides({
    slides: plan.slides.map((slide, index) => ({
      id: slide.id,
      content: slide.content,
      contentType: slide.contentType,
      name: slide.name,
      order: index,
    })),
  });
  // Warm every deck-sourced slide once before the recording clock starts:
  // google-svg content embeds font data whose first paint is expensive, and
  // that jank would otherwise delay the actions scheduled right after a
  // slide.show/slide.close during the performance (timing-gate drift).
  for (const slide of plan.slides) {
    if (slide.contentType !== "google-svg") continue;
    deps.slidesStore.trigger.setPreviewState({
      previewState: { isOpen: true, isMaximized: true, currentSlideId: slide.id, indexv: 0 },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  deps.slidesStore.trigger.setPreviewState({
    previewState: { isOpen: false, isMaximized: false, currentSlideId: null, indexv: 0 },
  });
  deps.whiteboardStore.trigger.setScene({ scene: EMPTY_WHITEBOARD_SCENE });
  try {
    await waitUntil(
      () => {
        const project = deps.workspace.getProject();
        if (project.id !== `studio-${plan.lesson.slug}`) {
          return false;
        }
        const model = deps.getEditor()?.getModel();
        return (
          !!model &&
          workspacePathFromMonacoModelUri(model.uri) === plan.workspace.entryFilePath &&
          deps.preview.getState() === null
        );
      },
      {
        timeoutMs: PREPARE_TIMEOUT_MS,
        signal,
        description: "the pinned workspace to load into the editor",
      },
    );
  } catch (error) {
    return failedResult(error instanceof Error ? error.message : String(error));
  }

  // ---- Start recording with the external narration -------------------------
  phase("start-recording");
  deps.nextEditor.startRecording({ audioBlob });
  try {
    await waitUntil(
      () => {
        const snapshot = deps.actor.getSnapshot();
        if (snapshot.context.error) {
          throw new StudioActionError(
            `Recording did not start: ${snapshot.context.error} (browser autoplay policy blocks unattended audio unless the run is started from a click or the browser allows autoplay)`,
          );
        }
        return (
          snapshot.matches("recording") &&
          snapshot.context.session !== null &&
          snapshot.context.audio.externalDurationMs !== null
        );
      },
      {
        timeoutMs: RECORDING_START_TIMEOUT_MS,
        signal,
        description: "the recorder to start with external narration",
      },
    );
  } catch (error) {
    return failedResult(error instanceof Error ? error.message : String(error));
  }

  const startSnapshot = deps.actor.getSnapshot();
  const sessionStartPerf = startSnapshot.context.session!.startedAtPerf;
  const measuredAudioMs = startSnapshot.context.audio.externalDurationMs!;
  if (Math.abs(measuredAudioMs - plan.narration.expectedDurationMs) > AUDIO_DURATION_TOLERANCE_MS) {
    abortController.abort();
    await deps.nextEditor.stopRecording();
    return failedResult(
      `Narration duration mismatch: fetched audio is ${Math.round(measuredAudioMs)}ms, plan pins ${plan.narration.expectedDurationMs}ms — wrong or stale audio asset`,
    );
  }

  const clock = { nowMs: () => performance.now() - sessionStartPerf };

  // ---- Perform -------------------------------------------------------------
  phase("perform");
  const driver = createStudioDriver({
    getEditor: deps.getEditor,
    workspace: deps.workspace,
    notifyWorkspaceEvent: () => deps.nextEditor.handleWorkspaceEvent(),
    runtimePanelStore: deps.runtimePanelStore,
    slidesStore: deps.slidesStore,
    whiteboardStore: deps.whiteboardStore,
    notifySlideEvent: (event) => deps.nextEditor.handleSlideEvent(event),
    notifyWhiteboardEvent: (event) => deps.nextEditor.handleWhiteboardEvent(event),
    notifyPreviewEvent: (event) => deps.nextEditor.handlePreviewEvent(event),
    runtimeMode,
    runtime: plan.runtime,
    planSeed: plan.seed,
    whiteboardAssets: plan.whiteboardAssets,
    webContainerRuntime: deps.webContainerRuntime,
    preview: deps.preview,
    signal,
  });

  let performOutcome: Awaited<ReturnType<typeof performPlan>>;
  try {
    performOutcome = await performPlan({
      plan,
      driver,
      clock,
      signal,
      abort: (reason) => {
        errors.push(reason);
        abortController.abort(reason);
      },
      onProgress: (receipt) => {
        receipts.push(receipt);
        deps.onProgress?.(receipt);
      },
    });
  } finally {
    driver.dispose();
  }

  // ---- Finalize ------------------------------------------------------------
  phase("finalize");
  if (performOutcome.status === "failed") {
    // Fail closed: stop audio + performance immediately, keep diagnostics only.
    try {
      await deps.nextEditor.stopRecording();
    } catch {
      // The machine may already have left `recording` via an audio error.
    }
  }

  const remainingMs = Math.max(0, measuredAudioMs - clock.nowMs());
  try {
    // Deliberately not the perform signal: finalize must still be awaited (and
    // diagnostics collected) after a failed performance aborted that signal.
    await waitUntil(
      () => {
        const snapshot = deps.actor.getSnapshot();
        return !snapshot.matches("recording") && snapshot.context.recording !== null;
      },
      {
        timeoutMs: remainingMs + FINALIZE_GRACE_MS,
        signal: new AbortController().signal,
        description: "the recording to finalize",
        intervalMs: 50,
      },
    );
  } catch (error) {
    return failedResult(error instanceof Error ? error.message : String(error));
  }

  if (performOutcome.status === "failed") {
    const failed = await failedResult(performOutcome.error ?? "The performance failed");
    failed.report.recordingDurationMs =
      deps.actor.getSnapshot().context.recording?.duration ?? null;
    return failed;
  }

  // ---- Captions + encode + QA ---------------------------------------------
  phase("qa");
  deps.nextEditor.addCaptionTrack(plan.narration.captions);
  const recording: Recording | null = deps.actor.getSnapshot().context.recording;
  if (!recording) {
    return failedResult("The finalized recording disappeared before encoding");
  }

  const baseFilename = `lesson-${plan.lesson.slug}`;
  let checks: StudioCheckResult[] = [];
  let neBlob: Blob;
  let audioFileName = "";
  try {
    const files = await buildRecordingFiles(recording, baseFilename);
    neBlob = files.ne;
    audioFileName = files.audio?.name ?? "";
    const neBytes = new Uint8Array(await files.ne.arrayBuffer());
    checks = await runArtifactChecks({
      recording,
      neBytes,
      plan,
      capturePreviewScreenshot: deps.preview.captureScreenshot,
    });
    if (plan.gates?.timingP95MaxMs !== undefined) {
      checks.push(timingGateCheck(computeTimingStats(receipts), plan.gates.timingP95MaxMs));
    }

    const semantics = await extractRenderSemantics(
      recording,
      receipts,
      audioBytes,
      await sha256HexOfJson(plan),
    );
    const allChecksOk = checks.every((check) => check.ok);
    const outcome = allChecksOk ? "passed" : "failed";
    if (!allChecksOk) {
      errors.push("One or more artifact checks failed");
    }

    const manifest = await baseManifest(plan, runtimeMode, audioHash, {
      neBytes: neBytes.byteLength,
      neHash: await sha256Hex(neBytes),
      audioFileName,
      recordingDurationMs: recording.duration,
      finalWorkspaceHash: await finalWorkspaceHashOf(recording),
    });

    return {
      report: {
        outcome,
        planSlug: plan.lesson.slug,
        runtimeMode,
        startedAtIso,
        wallDurationMs: Math.round(performance.now() - wallStart),
        recordingDurationMs: recording.duration,
        receipts,
        timing: computeTimingStats(receipts),
        checks,
        errors,
      },
      manifest,
      semantics,
      artifacts: allChecksOk ? { neBlob, audioBlob, audioFileName, recording } : null,
    };
  } catch (error) {
    const failed = await failedResult(
      `Encoding or QA failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    failed.report.recordingDurationMs = recording.duration;
    failed.report.checks = checks;
    return failed;
  }
}

async function baseManifest(
  plan: StudioPlan,
  runtimeMode: StudioRuntimeMode,
  audioHash: string | null,
  artifact: StudioBuildManifest["artifact"],
): Promise<StudioBuildManifest> {
  const runtimeContract =
    plan.runtime.kind === "webcontainer"
      ? {
          kind: "webcontainer" as const,
          adapterVersion: plan.runtime.adapterVersion,
          initCommand: plan.runtime.initCommand,
          runCommand: plan.runtime.runCommand,
          expectedPort: plan.runtime.expectedPort ?? null,
          lockfilePath: plan.runtime.lockfilePath,
          lockfileSha256: await sha256Hex(
            new TextEncoder().encode(plan.workspace.files[plan.runtime.lockfilePath] ?? ""),
          ),
          environmentSha256: await sha256HexOfJson(plan.runtime.environment),
        }
      : null;

  return {
    manifestVersion: 2,
    planSlug: plan.lesson.slug,
    planTitle: plan.lesson.title,
    planHash: await sha256HexOfJson(plan),
    seed: plan.seed,
    workspaceHash: await hashWorkspaceFiles(plan.workspace.files),
    narrationAudioHash: audioHash ?? "unfetched",
    narrationMimeType: plan.narration.mimeType,
    captionsHash: await sha256HexOfJson(plan.narration.captions),
    runtimeKind: plan.runtime.kind,
    runtimeMode,
    runtimeContract,
    environment: {
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      appMode: import.meta.env.MODE,
    },
    artifact,
  };
}

export { compareRenderSemantics };
