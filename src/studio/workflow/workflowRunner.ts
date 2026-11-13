import axios from "axios";
import type { Recording } from "../../core/src";
import type { StudioRenderReport } from "../report";
import { buildWorkflowIssueReport } from "./workflowIssue";
import {
  createWorkflow,
  failLesson,
  nextLessonIndex,
  nextStepOf,
  updateLesson,
  withWorkflowState,
  workflowProgressOf,
  type StudioWorkflow,
  type WorkflowDraft,
  type WorkflowLesson,
  type WorkflowLessonInput,
  type WorkflowSettings,
  type WorkflowStep,
} from "./workflowQueue";
import type { WorkflowUploadInput } from "./workflowUpload";

/**
 * The loop that takes a studio workflow's lessons through their steps: render
 * each with the studio, upload it as a draft, publish it, and stop at the
 * first failure with an issue report. A workflow that narrates first runs a
 * narration pass before the first render: every lesson's narration is
 * synthesized in one unbroken run, so a hosted speech GPU starts once instead
 * of once per lesson. Plain code behind injected effects (useStudioWorkflow
 * supplies the real ones), so the loop's stop and resume rules are tested
 * with fakes.
 */

/** One lesson's render, as the studio's Start render would do it. */
export type LessonRenderAttempt =
  | { ok: true; title: string; recording: Recording }
  | {
      ok: false;
      error: string;
      /** The phase the render was in when it failed. */
      phase: string | null;
      /** The finished render's report, when it got that far. */
      report: StudioRenderReport | null;
      buildWarnings: string[];
    };

/** One lesson's narration, synthesized ahead of its render by the narration pass. */
export type LessonNarrationAttempt =
  | { outcome: "ready" }
  /** Stopped between two dialogs because the workflow is stopping. */
  | { outcome: "cancelled" }
  /** Nothing synthesized now can be kept for the render, so narrating ahead only pays twice. */
  | { outcome: "cache-unavailable"; reason: string }
  | { outcome: "failed"; error: string };

/** Where the narration pass is, for the workflow panel. It lives in this page only. */
export interface WorkflowNarration {
  /** The lesson being narrated now and the Director phase it is in; null outside the pass. */
  active: { slug: string; phase: string } | null;
  /** Lessons whose narration is synthesized: their renders call no speech service. */
  ready: readonly string[];
  /**
   * The lesson the pass stopped early at, and why: its narration "failed"
   * (that lesson's render narrates it again), or the browser cannot keep
   * narration for the renders ("cache-unavailable": no more passes this run).
   */
  stopped: { slug: string; reason: "failed" | "cache-unavailable"; message: string } | null;
}

export const NO_WORKFLOW_NARRATION: WorkflowNarration = { active: null, ready: [], stopped: null };

export interface StudioWorkflowDeps {
  /**
   * Render one lesson with the studio's current narration settings, recording
   * the screen into `screenStream` when one is given (and never asking for one).
   */
  renderLesson: (slug: string, screenStream: MediaStream | null) => Promise<LessonRenderAttempt>;
  /**
   * Synthesize one lesson's narration with the studio's current narration
   * settings and keep it for that lesson's render, without rendering. Never
   * throws: a failure comes back as the attempt's error.
   */
  narrateLesson: (
    slug: string,
    options: { onPhase: (phase: string) => void; isCancelled: () => boolean },
  ) => Promise<LessonNarrationAttempt>;
  /** What narrates the renders, for the issue report. */
  narration: { provider: string; voice: string | null; runtimeMode: string | null };
  isImported: (slug: string) => boolean;
  /** Whether to record the screen: one stream, picked at Start, for every render. */
  screenRecording: boolean;
}

export interface NewWorkflowInput {
  lessons: WorkflowLessonInput[];
  settings: WorkflowSettings;
  /** Picked thumbnails by lesson slug. */
  thumbnails: ReadonlyMap<string, File>;
}

export interface WorkflowRunnerIo {
  /** Every change to the queue, for state, storage and the window handle. */
  commit: (workflow: StudioWorkflow) => void;
  onActiveLesson: (slug: string | null) => void;
  onUploadProgress: (progress: number | null) => void;
  /** The failed render's full report, or null once a lesson renders again. */
  onFailedReport: (report: StudioRenderReport | null) => void;
  onSetupError: (message: string | null) => void;
  /** Every change to where the narration pass is. */
  onNarration: (narration: WorkflowNarration) => void;
  acquireScreen: () => Promise<MediaStream>;
  storeThumbnails: (thumbnails: ReadonlyMap<string, File>) => Promise<void>;
  loadThumbnail: (slug: string) => Promise<File | null>;
  clearThumbnails: () => Promise<void>;
  uploadDraft: (input: WorkflowUploadInput) => Promise<WorkflowDraft>;
  publishDraft: (draft: WorkflowDraft) => Promise<void>;
  addToPlaylist: (playlistId: string, lessonId: string) => Promise<void>;
  /** A lesson was uploaded, published or added to a playlist: the library's cached lists are stale. */
  onLibraryChanged: () => void;
  newId: () => string;
  nowIso: () => string;
  environment: () => { origin: string; userAgent: string };
}

/** An error's message, with the server's answer when it is a failed API call. */
export function describeWorkflowError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const body: unknown = error.response?.data;
    const detail = typeof body === "string" ? body : body ? JSON.stringify(body) : "";
    return [error.message, status ? `HTTP ${status}` : null, detail.slice(0, 1_000) || null]
      .filter(Boolean)
      .join(" — ");
  }
  return error instanceof Error ? error.message : String(error);
}

interface LessonFailure {
  message: string;
  phase?: string | null;
  report?: StudioRenderReport | null;
  buildWarnings?: string[];
}

export function createWorkflowRunner(
  initial: StudioWorkflow | null,
  initialDeps: StudioWorkflowDeps,
  io: WorkflowRunnerIo,
) {
  let current = initial;
  // The studio's latest (narration settings can change between workflows).
  let deps = initialDeps;
  let running = false;
  let narration = NO_WORKFLOW_NARRATION;

  const commit = (next: StudioWorkflow) => {
    current = next;
    io.commit(next);
  };

  const setNarration = (patch: Partial<WorkflowNarration>) => {
    narration = { ...narration, ...patch };
    io.onNarration(narration);
  };

  /** Whether Stop was pressed. A call, because the state changes under an await. */
  const stopRequested = () => current?.state === "stopping";

  const lessonOf = (slug: string): WorkflowLesson => {
    const lesson = current?.lessons.find((candidate) => candidate.slug === slug);
    if (!lesson) throw new Error(`Lesson ${slug} left the workflow`);
    return lesson;
  };

  const update = (slug: string, patch: Partial<Omit<WorkflowLesson, "slug">>) => {
    if (current) commit(updateLesson(current, slug, patch));
  };

  const fail = (lesson: WorkflowLesson, step: WorkflowStep, failure: LessonFailure): false => {
    if (!current) return false;
    const atIso = io.nowIso();
    const report = buildWorkflowIssueReport({
      step,
      slug: lesson.slug,
      title: lesson.title,
      imported: deps.isImported(lesson.slug),
      message: failure.message,
      phase: failure.phase ?? null,
      position: {
        index: current.lessons.findIndex((candidate) => candidate.slug === lesson.slug),
        total: current.lessons.length,
        done: workflowProgressOf(current).done,
      },
      narration: deps.narration,
      report: failure.report ?? null,
      buildWarnings: failure.buildWarnings ?? [],
      atIso,
      ...io.environment(),
    });
    io.onFailedReport(failure.report ?? null);
    commit(
      failLesson(current, lesson.slug, {
        step,
        message: failure.message,
        phase: failure.phase ?? null,
        atIso,
        report,
      }),
    );
    return false;
  };

  /** Upload a passing render as the lesson's draft; false when it failed. */
  const uploadDraft = async (
    lesson: WorkflowLesson,
    settings: WorkflowSettings,
    rendered: { title: string; recording: Recording },
  ): Promise<boolean> => {
    const uploadId = lesson.uploadId ?? io.newId();
    update(lesson.slug, { status: "uploading", uploadId });
    io.onUploadProgress(0);
    try {
      const thumbnail = lesson.thumbnail ? await io.loadThumbnail(lesson.slug) : null;
      if (lesson.thumbnail && !thumbnail) {
        return fail(lesson, "draft", {
          message: `The picked thumbnail ${lesson.thumbnail} is no longer stored in this browser — start a new workflow and pick the folder again`,
        });
      }
      const draft = await io.uploadDraft({
        uploadId,
        title: rendered.title,
        recording: rendered.recording,
        thumbnail,
        useDefaultThumbnail: settings.defaultThumbnailWhenMissing,
        onProgress: io.onUploadProgress,
      });
      update(lesson.slug, { draft });
      io.onLibraryChanged();
      return true;
    } catch (error) {
      return fail(lesson, "draft", { message: describeWorkflowError(error) });
    } finally {
      io.onUploadProgress(null);
    }
  };

  /** Take one lesson through the steps it still needs; false when one failed. */
  const runLesson = async (slug: string, stream: MediaStream | null): Promise<boolean> => {
    const settings = current!.settings;
    const lesson = lessonOf(slug);

    if (nextStepOf(lesson, settings) === "render") {
      update(slug, { status: "rendering", issue: null });
      io.onFailedReport(null);
      // A clone per render: the recorder stops the tracks it is handed when
      // the lesson ends, and the next lesson needs the stream still live.
      const attempt = await deps.renderLesson(slug, stream?.clone() ?? null);
      if (!attempt.ok) {
        return fail(lesson, "render", {
          message: attempt.error,
          phase: attempt.phase,
          report: attempt.report,
          buildWarnings: attempt.buildWarnings,
        });
      }
      if (settings.createDraft && !(await uploadDraft(lesson, settings, attempt))) {
        return false;
      }
    }

    const ready = lessonOf(slug);
    if (nextStepOf(ready, settings) === "publish" && ready.draft) {
      update(slug, { status: "publishing", issue: null });
      try {
        await io.publishDraft(ready.draft);
      } catch (error) {
        return fail(ready, "publish", { message: describeWorkflowError(error) });
      }
      update(slug, { published: true });
      io.onLibraryChanged();
    }

    const listed = lessonOf(slug);
    const playlist = settings.playlist;
    if (nextStepOf(listed, settings) === "playlist" && listed.draft && playlist) {
      update(slug, { status: "adding", issue: null });
      try {
        await io.addToPlaylist(playlist.id, listed.draft.lessonId);
      } catch (error) {
        return fail(listed, "playlist", { message: describeWorkflowError(error) });
      }
      update(slug, { inPlaylist: true });
      io.onLibraryChanged();
    }

    update(slug, { status: "done", issue: null });
    return true;
  };

  /**
   * The narration pass: synthesize the narration of every lesson from
   * `fromIndex` on that still has to render, one lesson after another, before
   * any of them renders. The speech service then works in one unbroken run —
   * a hosted GPU starts once, instead of once per lesson with a recording's
   * idle time in between — and each render finds its dialogs already kept.
   *
   * The pass only moves synthesis earlier, so it never fails the workflow. At
   * a lesson it cannot narrate it stops and returns that lesson's slug: the
   * lessons before it render from what the pass kept, that lesson's render
   * synthesizes again (and reports a failure the way it always has), and the
   * queue runs the pass again for the lessons after it. Returns null when
   * nothing is left for a later pass: every lesson is narrated, the workflow
   * is stopping, or this browser cannot keep narration for the renders.
   */
  const narrateAhead = async (fromIndex: number): Promise<string | null> => {
    const settings = current!.settings;
    const slugs = current!.lessons
      .slice(fromIndex)
      .filter((lesson) => nextStepOf(lesson, settings) === "render")
      .map((lesson) => lesson.slug);
    let stoppedAt: string | null = null;
    setNarration({ stopped: null });
    try {
      for (const slug of slugs) {
        if (stopRequested()) break;
        setNarration({ active: { slug, phase: "starting" } });
        let attempt: LessonNarrationAttempt;
        try {
          attempt = await deps.narrateLesson(slug, {
            onPhase: (phase) => setNarration({ active: { slug, phase } }),
            isCancelled: stopRequested,
          });
        } catch (error) {
          // It promises not to throw; the pass still must not fail the workflow.
          attempt = { outcome: "failed", error: describeWorkflowError(error) };
        }
        if (attempt.outcome === "ready") {
          setNarration({ ready: [...new Set([...narration.ready, slug])] });
          continue;
        }
        if (attempt.outcome === "failed") {
          stoppedAt = slug;
          setNarration({ stopped: { slug, reason: "failed", message: attempt.error } });
        } else if (attempt.outcome === "cache-unavailable") {
          setNarration({
            stopped: { slug, reason: "cache-unavailable", message: attempt.reason },
          });
        }
        break;
      }
    } finally {
      setNarration({ active: null });
    }
    return stoppedAt;
  };

  const runQueue = async (stream: MediaStream | null) => {
    let narrationDue = current?.settings.narrateFirst === true;
    // The lesson the narration pass stopped at; the pass goes on after it renders.
    let narrationResumesAfter: string | null = null;
    while (current) {
      if (current.state === "stopping") {
        commit(withWorkflowState(current, "stopped"));
        return;
      }
      const index = nextLessonIndex(current);
      if (index < 0) {
        commit(withWorkflowState(current, "finished"));
        // Nothing resumes a finished workflow, so its thumbnails can go.
        void io.clearThumbnails().catch(() => undefined);
        return;
      }
      if (narrationDue) {
        narrationDue = false;
        // No lesson is rendering while the pass runs (the last one may be done).
        io.onActiveLesson(null);
        narrationResumesAfter = await narrateAhead(index);
        // Stop was pressed during the pass: nothing renders.
        if (stopRequested()) continue;
      }
      const slug = current.lessons[index].slug;
      io.onActiveLesson(slug);
      if (!(await runLesson(slug, stream))) return;
      if (slug === narrationResumesAfter) {
        narrationResumesAfter = null;
        narrationDue = true;
      }
    }
  };

  /**
   * Start a new workflow, or resume the current one at its first unfinished
   * lesson. Call it from the click: the screen picker needs the click's
   * activation, so it is asked for before anything else is awaited.
   */
  const start = async (fresh?: NewWorkflowInput) => {
    if (running) return;
    if (!fresh && (!current || current.state === "finished")) return;
    running = true;
    io.onSetupError(null);
    // What an earlier run narrated says nothing now: the voice may have changed.
    setNarration(NO_WORKFLOW_NARRATION);
    let stream: MediaStream | null = null;
    try {
      if (deps.screenRecording) {
        try {
          stream = await io.acquireScreen();
        } catch (error) {
          // A dismissed picker renders on without video, as Start render does.
          console.warn("Studio workflow screen capture not started; rendering without it:", error);
        }
      }
      if (fresh) {
        if (fresh.thumbnails.size > 0) {
          try {
            await io.storeThumbnails(fresh.thumbnails);
          } catch (error) {
            io.onSetupError(
              `Could not keep the thumbnails in this browser: ${describeWorkflowError(error)}`,
            );
            return;
          }
        } else {
          // Nothing to keep; only the last workflow's images to drop.
          void io.clearThumbnails().catch(() => undefined);
        }
        commit(
          createWorkflow({
            id: io.newId(),
            createdAtIso: io.nowIso(),
            settings: fresh.settings,
            lessons: fresh.lessons,
          }),
        );
      }
      const resumed = current!;
      commit({
        ...withWorkflowState(resumed, "running"),
        lessons: resumed.lessons.map((lesson) =>
          lesson.status === "failed" ? { ...lesson, status: "queued" } : lesson,
        ),
      });
      await runQueue(stream);
    } catch (error) {
      // A bug in the loop itself: stop at the lesson it was on.
      const lesson = current ? current.lessons[nextLessonIndex(current)] : undefined;
      if (lesson)
        fail(lesson, "render", { message: `Workflow error: ${describeWorkflowError(error)}` });
    } finally {
      running = false;
      io.onActiveLesson(null);
      for (const track of stream?.getTracks() ?? []) track.stop();
    }
  };

  /** Finish the lesson in progress, then stop. */
  const requestStop = () => {
    if (current?.state === "running") commit(withWorkflowState(current, "stopping"));
  };

  /** Hand the runner the studio's current dependencies. */
  const setDeps = (next: StudioWorkflowDeps) => {
    deps = next;
  };

  return { start, requestStop, setDeps };
}

export type WorkflowRunner = ReturnType<typeof createWorkflowRunner>;
