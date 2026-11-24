import type { StudioRuntimeMode } from "./plan";
import type { RenderSpeed } from "./renderClock";
import type { StudioBuildManifest, StudioCheckResult, StudioRenderReport } from "./report";
import type { StudioWorkflow } from "./workflow/workflowQueue";
import type { WorkflowNarration } from "./workflow/workflowRunner";

/**
 * What /studio publishes on `window.__NEXT_EDITOR_STUDIO__` so an automation
 * harness can read its renders without scraping the DOM. StudioController
 * writes it and scripts/studio-render.ts reads it; both use this one type, so
 * renaming a field fails the typecheck instead of a render. Types only — the
 * CLI imports it with `import type`, which bun strips, and gets the window
 * slot's declaration below with it.
 */
export interface StudioWindowHandle {
  runs: StudioWindowRun[];
  /** The repeatability verdict, published after the second render. */
  comparison: StudioCheckResult[] | null;
  running: boolean;
  /**
   * Why the last request to render ended before it became a run (an unknown
   * lesson, a voice that cannot speak it, a plan that did not build); null
   * otherwise. Without it a harness could only time out.
   */
  fatal?: string | null;
  /**
   * What a requested start is still waiting for (sign-in, capabilities, the
   * voice library, the lesson index); null when nothing.
   */
  waitingFor?: string | null;
  /**
   * The studio workflow's queue (useStudioWorkflow), with the issue report of
   * a lesson it stopped at; absent until the workflow hook publishes it.
   */
  workflow?: StudioWorkflow | null;
  /** The workflow's narration pass, so a long pass does not look like a stall. */
  narration?: WorkflowNarration | null;
  /**
   * The studio's controls as functions, for a harness. Present only when the
   * browser is driven by automation (`navigator.webdriver`). Every function
   * goes through the rule its button enforces and says why when it refuses, so
   * it can do nothing a person at the page could not.
   */
  automation?: StudioAutomation;
}

/** One finished render as the window handle carries it. */
export interface StudioWindowRun {
  index: number;
  mode: StudioRuntimeMode;
  outcome: StudioRenderReport["outcome"];
  report: StudioRenderReport;
  manifest: StudioBuildManifest;
}

/** Whether a requested start began, or the reason the studio gave for not starting it. */
export type StudioAutomationStart = { started: true } | { refused: string };

export interface StudioAutomationStatus {
  /** Whether a render or a workflow could start now. */
  ready: boolean;
  /** What the studio is still loading; null when nothing. */
  waitingFor: string | null;
  /** Why Start render is disabled for the selected lesson, in the words its tooltip uses; null when it is not. */
  renderBlockedReason: string | null;
  /** The same for the workflow's Start. */
  workflowBlockedReason: string | null;
  signedIn: boolean;
  /** The narration provider selected in this browser profile. */
  provider: string;
  /** Whether that provider charges for a dialog it has not narrated before. */
  providerIsPaid: boolean;
  /** The selected narrator voice's name; null for the provider's own voice. */
  voice: string | null;
  /** Whether this profile records the screen with a render. A harness cannot answer the screen picker. */
  screenRecording: boolean;
  /** The lesson index this page read: what it was built from and how many lessons it lists. */
  lessons: {
    status: "loading" | "ready" | "error";
    source: string | null;
    count: number;
    error: string | null;
  };
}

/** A file handed across the page boundary as bytes. */
export interface StudioAutomationFile {
  name: string;
  type: string;
  base64: string;
}

export interface StudioAutomationWorkflowInput {
  slugs: string[];
  settings: {
    createDraft: boolean;
    publish: boolean;
    defaultThumbnailWhenMissing: boolean;
    /** The playlist every published lesson joins; null for none. */
    playlistId: string | null;
    narrateFirst: boolean;
    /** Render off the wall clock where a lesson allows it. */
    fullSpeed: boolean;
  };
  /** Thumbnail images, matched to lessons by file name as the folder picker matches them. */
  thumbnails: StudioAutomationFile[];
}

/** How much of one lesson's narration this browser profile already keeps. */
export interface StudioAutomationCoverage {
  slug: string;
  dialogs: number;
  missing: number;
}

export type StudioAutomationLessonMatch =
  | {
      found: {
        lessonId: string;
        urlSlug: string;
        title: string;
        status: "draft" | "published";
        duration: string;
      };
    }
  /** No lesson of this author has the title, or several have: the reason names them. */
  | { refused: string };

/** What replacing a published lesson with the newest passing run would change, or did change. */
export interface StudioAutomationLessonChange {
  lessonId: string;
  urlSlug: string;
  /** Caption cues that differ between the published lesson and the run. */
  changedCues: number;
  totalCues: number;
  /** A few of the changed cues as "before → after", for a person to read. */
  examples: string[];
  publishedDurationMs: number;
  newDurationMs: number;
}

export type StudioAutomationReplacement =
  | { compared: StudioAutomationLessonChange }
  | {
      replaced: StudioAutomationLessonChange & {
        /** The narration file the lesson names now. */
        audioFile: string;
        /** The narration file that was deleted; null when it could not be, or there was none. */
        removedAudioFile: string | null;
      };
    }
  | { refused: string };

export interface StudioAutomation {
  /** What the studio would show a person now. */
  status(): StudioAutomationStatus;
  /** Start one render, as Start render does. The run then appears in `runs`, or `fatal` says why not. */
  startRender(input: {
    slug: string;
    runtimeMode?: StudioRuntimeMode;
    speed?: RenderSpeed;
  }): StudioAutomationStart;
  /**
   * The newest passing run's files: the lesson (.ne), its narration, the build
   * manifest and the render report. Null when the newest run did not pass.
   */
  latestBundle(): Promise<StudioAutomationFile[] | null>;
  /** How much narration the selected voice would have to synthesize for these lessons. */
  narrationCoverage(
    slugs: string[],
  ): Promise<
    { lessons: StudioAutomationCoverage[]; cacheUnavailable: string | null } | { refused: string }
  >;
  startWorkflow(input: StudioAutomationWorkflowInput): Promise<StudioAutomationStart>;
  /** Go on with the stored workflow, as Resume does. */
  resumeWorkflow(): Promise<StudioAutomationStart>;
  /** Stop after the lesson in hand, as Stop does. */
  stopWorkflow(): void;
  /** The signed-in author's lesson that a script was published as: by its title, or the one `lesson` names. */
  publishedLesson(input: { slug: string; lesson?: string }): Promise<StudioAutomationLessonMatch>;
  /**
   * Compare the published lesson with the newest passing run and, when
   * `replace` is true, put the run in its place: same id, URL, thumbnail,
   * playlist position and publish date.
   */
  replacePublishedLesson(input: {
    lessonId: string;
    replace: boolean;
  }): Promise<StudioAutomationReplacement>;
}

declare global {
  interface Window {
    __NEXT_EDITOR_STUDIO__?: StudioWindowHandle;
  }
}
