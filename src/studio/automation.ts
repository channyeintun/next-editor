import { base64ToBytes, bytesToBase64 } from "../shared/base64";
import { canonicalJson } from "./hash";
import type { NarrationCoverage } from "./narrationPack/coverage";
import type { StudioNarrationProvider } from "./narrationLanguage";
import type { StudioRuntimeMode } from "./plan";
import type { RenderSpeed } from "./renderClock";
import { parseRenderSpeedParam, parseRuntimeModeParam } from "./renderLaunch";
import type { StudioBuildManifest, StudioRenderReport } from "./report";
import type { StudioRunArtifacts } from "./runStudioRender";
import type {
  StudioAutomation,
  StudioAutomationFile,
  StudioAutomationLessonMatch,
  StudioAutomationReplacement,
  StudioAutomationStart,
  StudioAutomationStatus,
  StudioAutomationWorkflowInput,
} from "./studioWindowHandle";
import type { StudioWorkflow, WorkflowSettings } from "./workflow/workflowQueue";
import type { NewWorkflowInput, WorkflowStartOptions } from "./workflow/workflowRunner";
import { planWorkflowStart, type WorkflowLessonInfo } from "./workflow/workflowStart";

/**
 * The studio's controls as plain functions on `window.__NEXT_EDITOR_STUDIO__`,
 * for a harness that drives the studio without clicking (scripts/studio-render.ts).
 * Every function goes through the same rule its button does and says why it
 * refuses, so a harness can do nothing a person at the page could not. The
 * studio hands in what it shows now; nothing here holds React state.
 */

/** A run as the studio keeps it, for the bundle and for replacing a published lesson. */
export interface StudioAutomationRun {
  slug: string;
  /** The script's title when the run rendered it. */
  title: string;
  /** Whether the run was made from the script the studio lists under its slug now. */
  current: boolean;
  report: StudioRenderReport;
  manifest: StudioBuildManifest;
  /** Present only when the run passed every gate. */
  artifacts: StudioRunArtifacts | null;
}

/** What the studio shows and can do right now. Read again on every call. */
export interface StudioAutomationDeps {
  /** What a start still waits for (studioWaitingFor); null when the studio is ready. */
  waitingFor: string | null;
  /** A render or a workflow is running. */
  busy: boolean;
  /** Why Start render is disabled for the selected lesson, as its tooltip says. */
  renderBlockedReason: string | null;
  /** The same for any lesson, with the conditions the button is disabled for without saying so. */
  renderBlockedReasonOf: (slug: string) => string | null;
  /** Why Start workflow is disabled, as the panel says. */
  workflowBlockedReason: string | null;
  /** Why Resume is disabled, as the panel says. */
  workflowResumeBlockedReason: string | null;
  signedIn: boolean;
  provider: StudioNarrationProvider;
  voice: string | null;
  screenRecording: boolean;
  lessons: StudioAutomationStatus["lessons"];
  /** The workflow's view of a lesson: its title, or why the workflow cannot take it. */
  lessonOf: (slug: string) => WorkflowLessonInfo;
  /** A listed lesson's title from the lesson list; null when the list does not name it. */
  titleOf: (slug: string) => string | null;
  /** Select the lesson (and the mode and speed when given) and start the render Start render starts, with no screen stream. */
  render: (input: { slug: string; runtimeMode?: StudioRuntimeMode; speed?: RenderSpeed }) => void;
  /** The newest run in this page, or null before the first. */
  latestRun: () => StudioAutomationRun | null;
  /** The studio's narration coverage for these lessons with the selected voice; throws naming lessons it cannot narrate. */
  narrationCoverage: (slugs: string[]) => Promise<NarrationCoverage>;
  /** The signed-in author's playlists; null until they have been read. */
  playlists: readonly { id: string; title: string }[] | null;
  workflow: {
    current: StudioWorkflow | null;
    active: boolean;
    start: (fresh?: NewWorkflowInput, options?: WorkflowStartOptions) => Promise<void>;
    requestStop: () => void;
  };
  findPublishedLesson: (input: {
    title: string;
    lesson?: string;
  }) => Promise<StudioAutomationLessonMatch>;
  replacePublishedLesson: (input: {
    lessonId: string;
    run: { title: string; artifacts: StudioRunArtifacts };
    replace: boolean;
  }) => Promise<StudioAutomationReplacement>;
}

/** What the studio needs before a start reads the settings a person would see. */
export interface StudioReadiness {
  lessons: "loading" | "ready" | "error";
  authLoading: boolean;
  capabilitiesLoading: boolean;
  provider: StudioNarrationProvider;
  voxCpm2Enabled: boolean;
  narratorVoiceReported: boolean;
  /** Whether the AthanLab panel has given its first answer (key, voice, balance). */
  athanLabReported: boolean;
}

/**
 * What a start is still waiting for, or null. Before these are known, a
 * render would read the studio's mount-time defaults: the built-in voice in
 * place of the saved one, a provider the account cannot use. Autostart waits
 * for the same, and so does every automation start. An AthanLab account that
 * has answered is not waited for: what it lacks (an empty balance, say) is a
 * reason a start is blocked, and resuming a workflow is allowed on an empty
 * balance where starting one is not.
 */
export function studioWaitingFor(readiness: StudioReadiness): string | null {
  if (readiness.lessons === "loading") return "the list of published lessons";
  if (readiness.authLoading) return "the sign-in state";
  if (readiness.capabilitiesLoading) return "this account's studio capabilities";
  // The console moves off VoxCPM2 for an account without it on the next render.
  if (readiness.provider === "voxcpm2" && !readiness.voxCpm2Enabled) {
    return "the switch from VoxCPM2, which this account cannot use, to the English voice";
  }
  if (!readiness.narratorVoiceReported) return "the saved narrator voices";
  if (readiness.provider === "athanlab" && !readiness.athanLabReported) {
    return "your AthanLab setup";
  }
  return null;
}

/** A run's bundle: the four files Download bundle saves, under the names it saves them as. */
export function runBundleFilesOf(run: {
  report: StudioRenderReport;
  manifest: StudioBuildManifest;
  artifacts: StudioRunArtifacts;
}): { name: string; blob: Blob }[] {
  const base = `lesson-${run.report.planSlug}`;
  return [
    { name: `${base}.ne`, blob: run.artifacts.neBlob },
    { name: run.artifacts.audioFileName || `${base}.m4a`, blob: run.artifacts.audioBlob },
    {
      name: "build-manifest.json",
      blob: new Blob([canonicalJson(run.manifest)], { type: "application/json" }),
    },
    {
      name: "render-report.json",
      blob: new Blob([JSON.stringify(run.report, null, 2)], { type: "application/json" }),
    },
  ];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileOf(name: string, blob: Blob): Promise<StudioAutomationFile> {
  return {
    name,
    type: blob.type || "application/octet-stream",
    base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())),
  };
}

/**
 * One automation object for the life of the studio: `deps` is called on
 * every use, so each function reads what the studio shows at that moment.
 */
export function createStudioAutomation(deps: () => StudioAutomationDeps): StudioAutomation {
  /** Why nothing can start now, before any rule of a particular button. */
  const notReady = (studio: StudioAutomationDeps): string | null =>
    studio.waitingFor === null
      ? null
      : `The studio is not ready: waiting for ${studio.waitingFor}.`;

  /** Hand the start to the runner and answer once it has begun or said why not. */
  const startRunner = (
    studio: StudioAutomationDeps,
    fresh?: NewWorkflowInput,
  ): Promise<StudioAutomationStart> =>
    new Promise((resolve) => {
      const answer = (refusal: string | null) =>
        resolve(refusal === null ? { started: true } : { refused: refusal });
      // Nobody is at the page to answer a screen picker.
      studio.workflow
        .start(fresh, { recordScreen: false, onBegin: answer })
        .catch((error: unknown) => answer(messageOf(error)));
    });

  /** The newest run when it can be handed on, or why it cannot. */
  const passingRun = (
    studio: StudioAutomationDeps,
  ): (StudioAutomationRun & { artifacts: StudioRunArtifacts }) | { refused: string } => {
    const run = studio.latestRun();
    if (!run) return { refused: "No render has run in this page yet." };
    if (run.report.outcome !== "passed" || !run.artifacts) {
      return { refused: `The newest run (${run.slug}) did not pass: render it again.` };
    }
    if (!run.current) {
      return {
        refused: `The newest run was made from an older version of "${run.slug}": render it again.`,
      };
    }
    return { ...run, artifacts: run.artifacts };
  };

  return {
    status() {
      const studio = deps();
      return {
        ready: studio.waitingFor === null,
        waitingFor: studio.waitingFor,
        renderBlockedReason: studio.renderBlockedReason,
        workflowBlockedReason: studio.workflowBlockedReason,
        signedIn: studio.signedIn,
        provider: studio.provider,
        // Pocket-TTS runs in this page; every other voice is a paid service.
        providerIsPaid: studio.provider !== "pocket",
        voice: studio.voice,
        screenRecording: studio.screenRecording,
        lessons: studio.lessons,
      };
    },

    startRender({ slug, runtimeMode, speed }) {
      const studio = deps();
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      // The harness's values arrive untyped; the URL's parsers say what is valid.
      if (runtimeMode !== undefined && parseRuntimeModeParam(runtimeMode).mode === null) {
        return {
          refused: `Unknown runtime mode "${String(runtimeMode)}": expected fixture or live.`,
        };
      }
      if (speed !== undefined && parseRenderSpeedParam(speed).speed === null) {
        return { refused: `Unknown speed "${String(speed)}": expected full or real.` };
      }
      if (studio.busy) return { refused: "A render or a workflow is running." };
      const blocked = studio.renderBlockedReasonOf(slug);
      if (blocked) return { refused: blocked };
      studio.render({ slug, runtimeMode, speed });
      return { started: true };
    },

    async latestBundle() {
      const run = deps().latestRun();
      if (!run || run.report.outcome !== "passed" || !run.artifacts) return null;
      const files = runBundleFilesOf({ ...run, artifacts: run.artifacts });
      return Promise.all(files.map(({ name, blob }) => fileOf(name, blob)));
    },

    async narrationCoverage(slugs) {
      const studio = deps();
      // Before the voice library reports, the count would be for the wrong voice.
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      try {
        const coverage = await studio.narrationCoverage(slugs);
        return {
          lessons: coverage.lessons.map((lesson) => ({
            slug: lesson.slug,
            dialogs: lesson.dialogCount,
            missing: lesson.missingCount,
          })),
          cacheUnavailable: coverage.cacheUnavailable,
        };
      } catch (error) {
        return { refused: messageOf(error) };
      }
    },

    async startWorkflow(input: StudioAutomationWorkflowInput) {
      const studio = deps();
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      if (studio.workflow.active) return { refused: "A workflow is running." };

      const { playlistId, ...choices } = input.settings;
      let playlist: WorkflowSettings["playlist"] = null;
      if (playlistId !== null) {
        if (!choices.publish) {
          return { refused: "Only a published lesson joins a playlist: turn publishing on." };
        }
        if (studio.playlists === null) {
          return { refused: "Your playlists have not been read yet: try again in a moment." };
        }
        const owned = studio.playlists.find((candidate) => candidate.id === playlistId);
        if (!owned) return { refused: `The playlist "${playlistId}" is not one of yours.` };
        playlist = { id: owned.id, title: owned.title };
      }

      let thumbnails: File[];
      try {
        thumbnails = input.thumbnails.map(
          (file) =>
            new File([new Uint8Array(base64ToBytes(file.base64))], file.name, { type: file.type }),
        );
      } catch (error) {
        return { refused: `A thumbnail could not be read: ${messageOf(error)}` };
      }

      const plan = planWorkflowStart({
        slugs: input.slugs,
        settings: { ...choices, playlist },
        thumbnails,
        lessonOf: studio.lessonOf,
        blockedReason: studio.workflowBlockedReason,
      });
      if ("refused" in plan.outcome) return { refused: plan.outcome.refused };
      return startRunner(studio, plan.outcome.start);
    },

    async resumeWorkflow() {
      const studio = deps();
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      const current = studio.workflow.current;
      if (!current) return { refused: "There is no workflow to resume." };
      if (studio.workflow.active) return { refused: "A workflow is running." };
      if (current.state === "finished") return { refused: "The workflow has finished." };
      // A workflow that was built but never ran starts like a new one.
      const blocked =
        current.state === "ready"
          ? studio.workflowBlockedReason
          : studio.workflowResumeBlockedReason;
      if (blocked) return { refused: blocked };
      return startRunner(studio);
    },

    stopWorkflow() {
      deps().workflow.requestStop();
    },

    async publishedLesson({ slug, lesson }) {
      const studio = deps();
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      if (!studio.signedIn)
        return { refused: "Sign in first: only your own lessons are looked up." };
      const title = studio.titleOf(slug);
      if (title === null) return { refused: `Unknown lesson "${slug}".` };
      try {
        return await studio.findPublishedLesson({ title, lesson });
      } catch (error) {
        return { refused: messageOf(error) };
      }
    },

    async replacePublishedLesson({ lessonId, replace }) {
      const studio = deps();
      const waiting = notReady(studio);
      if (waiting) return { refused: waiting };
      if (!studio.signedIn)
        return { refused: "Sign in first: only your own lessons are replaced." };
      if (studio.busy) return { refused: "A render or a workflow is running." };
      const run = passingRun(studio);
      if ("refused" in run) return run;
      try {
        return await studio.replacePublishedLesson({
          lessonId,
          run: { title: run.title, artifacts: run.artifacts },
          replace,
        });
      } catch (error) {
        return { refused: messageOf(error) };
      }
    },
  };
}

/**
 * Put the automation on the window handle, only in a browser driven by
 * automation (`navigator.webdriver`): a person's browser never gets it. It is
 * a convenience, not a guard: it can do only what the buttons can. Returns
 * the function that takes it off again.
 */
export function installStudioAutomation(automation: StudioAutomation): () => void {
  if (typeof navigator === "undefined" || navigator.webdriver !== true) return () => {};
  const handle = window.__NEXT_EDITOR_STUDIO__ ?? { runs: [], comparison: null, running: false };
  window.__NEXT_EDITOR_STUDIO__ = { ...handle, automation };
  return () => {
    const current = window.__NEXT_EDITOR_STUDIO__;
    if (current?.automation !== automation) return;
    const { automation: _removed, ...rest } = current;
    window.__NEXT_EDITOR_STUDIO__ = rest;
  };
}
