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
 * first failure with an issue report. Plain code behind injected effects
 * (useStudioWorkflow supplies the real ones), so the loop's stop and resume
 * rules are tested with fakes.
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

export interface StudioWorkflowDeps {
  /**
   * Render one lesson with the studio's current narration settings, recording
   * the screen into `screenStream` when one is given (and never asking for one).
   */
  renderLesson: (slug: string, screenStream: MediaStream | null) => Promise<LessonRenderAttempt>;
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

  const commit = (next: StudioWorkflow) => {
    current = next;
    io.commit(next);
  };

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

  const runQueue = async (stream: MediaStream | null) => {
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
      const slug = current.lessons[index].slug;
      io.onActiveLesson(slug);
      if (!(await runLesson(slug, stream))) return;
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
