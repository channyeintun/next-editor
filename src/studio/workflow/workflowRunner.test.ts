import { describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../../core/src";
import type { StudioRenderReport } from "../report";
import {
  createWorkflowRunner,
  type LessonRenderAttempt,
  type StudioWorkflowDeps,
  type WorkflowRunnerIo,
} from "./workflowRunner";
import type { StudioWorkflow, WorkflowSettings } from "./workflowQueue";

const SETTINGS: WorkflowSettings = {
  createDraft: true,
  publish: true,
  defaultThumbnailWhenMissing: false,
};

const RECORDING = { id: "recording" } as unknown as Recording;

function passed(title: string): LessonRenderAttempt {
  return { ok: true, title, recording: RECORDING };
}

function failedReport(): StudioRenderReport {
  return {
    outcome: "failed",
    planSlug: "b",
    runtimeMode: "fixture",
    startedAtIso: "2026-10-24T00:00:00.000Z",
    wallDurationMs: 1,
    recordingDurationMs: 1,
    receipts: [
      {
        actionId: "select-x",
        actionType: "editor.select",
        status: "failed",
        plannedAtMs: 1200,
        startedAtMs: 1210,
        endedAtMs: null,
        error: "text not found",
      },
      {
        actionId: "after",
        actionType: "editor.type",
        status: "skipped",
        plannedAtMs: 1500,
        startedAtMs: null,
        endedAtMs: null,
      },
    ],
    timing: null,
    checks: [{ id: "receipts-complete", ok: false, detail: "1 action failed" }],
    errors: [],
  };
}

/** A stream whose clones are counted, so the test can see one per render. */
function fakeStream() {
  const stop = vi.fn<() => void>();
  const clones: unknown[] = [];
  const stream = {
    clone: () => {
      const clone = { id: `clone-${clones.length}` };
      clones.push(clone);
      return clone;
    },
    getTracks: () => [{ stop }],
  } as unknown as MediaStream;
  return { stream, clones, stop };
}

const runnerRef: { current: ReturnType<typeof createWorkflowRunner> | null } = { current: null };

function harness(options: {
  renders: Record<string, LessonRenderAttempt[]>;
  publishFailures?: number;
  thumbnails?: Record<string, File>;
  screenRecording?: boolean;
  /** Runs while a lesson renders, as Chan clicking mid-render would. */
  duringRender?: (slug: string) => void;
  playlistFailures?: number;
}) {
  const commits: StudioWorkflow[] = [];
  const renderCalls: { slug: string; stream: MediaStream | null }[] = [];
  const uploads: { uploadId: string; title: string; thumbnail: File | null }[] = [];
  const published: string[] = [];
  const playlisted: string[] = [];
  let playlistFailures = options.playlistFailures ?? 0;
  const libraryChanges = { count: 0 };
  let publishFailures = options.publishFailures ?? 0;
  const screen = fakeStream();
  const storedThumbnails = new Map(Object.entries(options.thumbnails ?? {}));
  let ids = 0;

  const deps: StudioWorkflowDeps = {
    renderLesson: async (slug, stream) => {
      renderCalls.push({ slug, stream });
      options.duringRender?.(slug);
      const next = options.renders[slug]?.shift();
      if (!next) throw new Error(`no render scripted for ${slug}`);
      return next;
    },
    narration: { provider: "VoxCPM2", voice: "Chan", runtimeMode: null },
    isImported: () => false,
    screenRecording: options.screenRecording ?? false,
  };
  const io: WorkflowRunnerIo = {
    commit: (workflow) => commits.push(workflow),
    onActiveLesson: () => undefined,
    onUploadProgress: () => undefined,
    onFailedReport: () => undefined,
    onSetupError: () => undefined,
    acquireScreen: async () => screen.stream,
    storeThumbnails: async (thumbnails) => {
      storedThumbnails.clear();
      for (const [slug, file] of thumbnails) storedThumbnails.set(slug, file);
    },
    loadThumbnail: async (slug) => storedThumbnails.get(slug) ?? null,
    clearThumbnails: async () => storedThumbnails.clear(),
    uploadDraft: async (input) => {
      uploads.push({ uploadId: input.uploadId, title: input.title, thumbnail: input.thumbnail });
      return { lessonId: `lesson-${input.uploadId}`, urlSlug: input.title.toLowerCase() };
    },
    publishDraft: async (draft) => {
      if (publishFailures > 0) {
        publishFailures -= 1;
        throw new Error("publish refused");
      }
      published.push(draft.lessonId);
    },
    addToPlaylist: async (playlistId, lessonId) => {
      if (playlistFailures > 0) {
        playlistFailures -= 1;
        throw new Error("playlist refused");
      }
      playlisted.push(`${playlistId}:${lessonId}`);
    },
    onLibraryChanged: () => {
      libraryChanges.count += 1;
    },
    newId: () => `id-${++ids}`,
    nowIso: () => "2026-10-24T00:00:00.000Z",
    environment: () => ({ origin: "https://example.test", userAgent: "test" }),
  };
  const runner = createWorkflowRunner(null, deps, io);
  runnerRef.current = runner;
  const latest = () => commits.at(-1)!;
  return {
    runner,
    commits,
    latest,
    renderCalls,
    uploads,
    published,
    playlisted,
    libraryChanges,
    screen,
    storedThumbnails,
  };
}

const lessons = [
  { slug: "a", title: "A", thumbnail: "01-a.png" },
  { slug: "b", title: "B", thumbnail: null },
];
/** The same lessons with no thumbnail picked. */
const unillustrated = lessons.map((lesson) => ({ ...lesson, thumbnail: null }));

describe("createWorkflowRunner", () => {
  it("takes every lesson through render, draft and publish, then finishes", async () => {
    const thumbnail = new File(["png"], "01-a.png", { type: "image/png" });
    const run = harness({
      renders: { a: [passed("A")], b: [passed("B")] },
      screenRecording: true,
    });

    await run.runner.start({
      lessons,
      settings: { ...SETTINGS, defaultThumbnailWhenMissing: true },
      thumbnails: new Map([["a", thumbnail]]),
    });

    expect(run.latest().state).toBe("finished");
    expect(run.latest().lessons.map((lesson) => [lesson.status, lesson.published])).toEqual([
      ["done", true],
      ["done", true],
    ]);
    expect(run.uploads.map((upload) => upload.thumbnail)).toEqual([thumbnail, null]);
    expect(run.published).toHaveLength(2);
    // One picker at Start; each render gets its own clone, and the source
    // stream is stopped once the workflow ends.
    expect(run.renderCalls.map((call) => call.stream)).toEqual(run.screen.clones);
    expect(run.screen.clones).toHaveLength(2);
    expect(run.screen.stop).toHaveBeenCalledTimes(1);
    expect(run.storedThumbnails.size).toBe(0);
  });

  it("stops at a failed render with an issue report, and resumes at that lesson", async () => {
    const run = harness({
      renders: {
        a: [passed("A")],
        b: [
          {
            ok: false,
            error: 'Action "select-x" (editor.select) failed: text not found',
            phase: "perform",
            report: failedReport(),
            buildWarnings: ['Skipped the pointer click before "run"'],
          },
          passed("B"),
        ],
      },
    });

    await run.runner.start({ lessons: unillustrated, settings: SETTINGS, thumbnails: new Map() });

    const stopped = run.latest();
    expect(stopped.state).toBe("failed");
    expect(stopped.lessons.map((lesson) => lesson.status)).toEqual(["done", "failed"]);
    const issue = stopped.lessons[1].issue!;
    expect(issue).toMatchObject({ step: "render", phase: "perform" });
    expect(issue.report).toContain("## Studio workflow stopped at b");
    expect(issue.report).toContain("`src/studio/scripts/b.yaml`");
    expect(issue.report).toContain("text not found");
    expect(issue.report).toContain("lesson 2 of 2; 1 done before it stopped");
    // A skipped action says nothing about the failure.
    expect(issue.report).not.toContain("`after`");

    await run.runner.start();

    expect(run.latest().state).toBe("finished");
    expect(run.renderCalls.map((call) => call.slug)).toEqual(["a", "b", "b"]);
  });

  it("resumes a failed publish by publishing the draft it already has", async () => {
    const run = harness({ renders: { a: [passed("A")], b: [passed("B")] }, publishFailures: 1 });

    await run.runner.start({ lessons: unillustrated, settings: SETTINGS, thumbnails: new Map() });

    expect(run.latest().state).toBe("failed");
    expect(run.latest().lessons[0]).toMatchObject({
      status: "failed",
      published: false,
      draft: { lessonId: "lesson-id-2" },
      issue: { step: "publish", message: "publish refused" },
    });

    await run.runner.start();

    expect(run.latest().state).toBe("finished");
    // No second render or upload for "a": only the publish was retried.
    expect(run.renderCalls.map((call) => call.slug)).toEqual(["a", "b"]);
    expect(run.uploads).toHaveLength(2);
    expect(run.published[0]).toBe("lesson-id-2");
  });

  it("finishes the lesson in progress before a requested stop takes effect", async () => {
    const run = harness({
      renders: { a: [passed("A")], b: [passed("B")] },
      duringRender: (slug) => {
        if (slug === "a") runnerRef.current?.requestStop();
      },
    });

    await run.runner.start({ lessons: unillustrated, settings: SETTINGS, thumbnails: new Map() });

    expect(run.latest().state).toBe("stopped");
    expect(run.latest().lessons.map((lesson) => lesson.status)).toEqual(["done", "queued"]);
  });

  it("fails the draft step when a picked thumbnail is no longer stored", async () => {
    const run = harness({ renders: { a: [passed("A")] } });

    await run.runner.start({
      lessons: [lessons[0]],
      settings: SETTINGS,
      // Picked (the lesson names it) but never stored.
      thumbnails: new Map(),
    });

    expect(run.latest().lessons[0].issue).toMatchObject({ step: "draft" });
    expect(run.latest().lessons[0].issue!.message).toContain("01-a.png is no longer stored");
    expect(run.uploads).toEqual([]);
  });

  it("renders only, with no upload, when drafts are off", async () => {
    const run = harness({ renders: { a: [passed("A")] } });

    await run.runner.start({
      lessons: [lessons[0]],
      settings: { createDraft: false, publish: false, defaultThumbnailWhenMissing: false },
      thumbnails: new Map(),
    });

    expect(run.latest().state).toBe("finished");
    expect(run.latest().lessons[0]).toMatchObject({ status: "done", draft: null });
    expect(run.uploads).toEqual([]);
  });

  it("appends each published lesson to the chosen playlist, in workflow order", async () => {
    const run = harness({ renders: { a: [passed("A")], b: [passed("B")] } });

    await run.runner.start({
      lessons: unillustrated,
      settings: { ...SETTINGS, playlist: { id: "css", title: "CSS course" } },
      thumbnails: new Map(),
    });

    expect(run.latest().state).toBe("finished");
    expect(run.playlisted).toEqual(["css:lesson-id-2", "css:lesson-id-3"]);
    expect(run.latest().lessons.every((lesson) => lesson.inPlaylist)).toBe(true);
    // Each upload, publish and add refreshes the library's cached lists.
    expect(run.libraryChanges.count).toBe(6);
  });

  it("resumes a failed playlist add by adding only", async () => {
    const run = harness({ renders: { a: [passed("A")], b: [passed("B")] }, playlistFailures: 1 });
    const settings = { ...SETTINGS, playlist: { id: "css", title: "CSS course" } };

    await run.runner.start({ lessons: unillustrated, settings, thumbnails: new Map() });

    expect(run.latest().lessons[0]).toMatchObject({
      status: "failed",
      published: true,
      inPlaylist: false,
      issue: { step: "playlist", message: "playlist refused" },
    });

    await run.runner.start();

    expect(run.latest().state).toBe("finished");
    expect(run.renderCalls.map((call) => call.slug)).toEqual(["a", "b"]);
    expect(run.published).toHaveLength(2);
    expect(run.playlisted).toEqual(["css:lesson-id-2", "css:lesson-id-3"]);
  });
});
