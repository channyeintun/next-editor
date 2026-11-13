import { describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "../../core/src";
import type { StudioRenderReport } from "../report";
import {
  createWorkflowRunner,
  type LessonNarrationAttempt,
  type LessonRenderAttempt,
  type StudioWorkflowDeps,
  type WorkflowNarration,
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
  /** Each lesson's narration attempts in order; one left out is ready. */
  narrations?: Record<string, LessonNarrationAttempt[]>;
  /** Runs while a lesson is narrated ahead, as Chan clicking mid-pass would. */
  duringNarration?: (slug: string, isCancelled: () => boolean) => void;
}) {
  const commits: StudioWorkflow[] = [];
  /** Narrations and renders in the order the runner asked for them. */
  const steps: string[] = [];
  const narrationStates: WorkflowNarration[] = [];
  /** The lesson the runner called active (rendering) each time a narration began. */
  const activeDuringNarration: (string | null)[] = [];
  let activeLesson: string | null = null;
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
    narrateLesson: async (slug, { onPhase, isCancelled }) => {
      steps.push(`narrate ${slug}`);
      activeDuringNarration.push(activeLesson);
      onPhase("synthesize 1/1");
      options.duringNarration?.(slug, isCancelled);
      if (isCancelled()) return { outcome: "cancelled" };
      return options.narrations?.[slug]?.shift() ?? { outcome: "ready" };
    },
    renderLesson: async (slug, stream) => {
      steps.push(`render ${slug}`);
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
    onActiveLesson: (slug) => {
      activeLesson = slug;
    },
    onUploadProgress: () => undefined,
    onFailedReport: () => undefined,
    onSetupError: () => undefined,
    onNarration: (narration) => narrationStates.push(narration),
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
    steps,
    narrationStates,
    activeDuringNarration,
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

  describe("narrating first", () => {
    const three = ["a", "b", "c"].map((slug) => ({
      slug,
      title: slug.toUpperCase(),
      thumbnail: null,
    }));
    const narrateFirst = { ...SETTINGS, narrateFirst: true };

    it("narrates every lesson before the first one renders", async () => {
      const run = harness({ renders: { a: [passed("A")], b: [passed("B")], c: [passed("C")] } });

      await run.runner.start({ lessons: three, settings: narrateFirst, thumbnails: new Map() });

      expect(run.latest().state).toBe("finished");
      expect(run.steps).toEqual([
        "narrate a",
        "narrate b",
        "narrate c",
        "render a",
        "render b",
        "render c",
      ]);
      expect(run.narrationStates).toContainEqual({
        active: { slug: "b", phase: "synthesize 1/1" },
        ready: ["a"],
        stopped: null,
      });
      expect(run.narrationStates.at(-1)).toEqual({
        active: null,
        ready: ["a", "b", "c"],
        stopped: null,
      });
    });

    it("narrates each lesson as it renders when the setting is off or absent", async () => {
      const run = harness({ renders: { a: [passed("A")], b: [passed("B")] } });

      await run.runner.start({ lessons: unillustrated, settings: SETTINGS, thumbnails: new Map() });

      expect(run.steps).toEqual(["render a", "render b"]);
    });

    it("renders on past a lesson it could not narrate, then narrates the rest", async () => {
      const run = harness({
        renders: { a: [passed("A")], b: [passed("B")], c: [passed("C")] },
        narrations: { b: [{ outcome: "failed", error: "HTTP 504" }] },
      });

      await run.runner.start({ lessons: three, settings: narrateFirst, thumbnails: new Map() });

      // The pass never fails the workflow: b's own render narrates it again,
      // and only then is c narrated ahead of its render.
      expect(run.latest().state).toBe("finished");
      expect(run.steps).toEqual([
        "narrate a",
        "narrate b",
        "render a",
        "render b",
        "narrate c",
        "render c",
      ]);
      expect(run.narrationStates).toContainEqual({
        active: null,
        ready: ["a"],
        stopped: { slug: "b", reason: "failed", message: "HTTP 504" },
      });
      expect(run.narrationStates.at(-1)).toEqual({
        active: null,
        ready: ["a", "c"],
        stopped: null,
      });
      // b is done by the time c is narrated: no lesson is called rendering then.
      expect(run.activeDuringNarration).toEqual([null, null, null]);
    });

    it("treats a narration that throws as one that failed", async () => {
      const run = harness({
        renders: { a: [passed("A")], b: [passed("B")] },
        duringNarration: (slug) => {
          if (slug === "a") throw new Error("narrator exploded");
        },
      });

      await run.runner.start({
        lessons: unillustrated,
        settings: narrateFirst,
        thumbnails: new Map(),
      });

      expect(run.latest().state).toBe("finished");
      expect(run.steps).toEqual(["narrate a", "render a", "narrate b", "render b"]);
      expect(run.narrationStates).toContainEqual({
        active: null,
        ready: [],
        stopped: { slug: "a", reason: "failed", message: "narrator exploded" },
      });
    });

    it("leaves a narration failure to that lesson's render to report", async () => {
      const run = harness({
        renders: {
          a: [
            {
              ok: false,
              error: "Narration dialog 3/40: HTTP 504",
              phase: "synthesize 3/40",
              report: null,
              buildWarnings: [],
            },
            passed("A"),
          ],
          b: [passed("B")],
        },
        narrations: { a: [{ outcome: "failed", error: "Narration dialog 3/40: HTTP 504" }] },
      });

      await run.runner.start({
        lessons: unillustrated,
        settings: narrateFirst,
        thumbnails: new Map(),
      });

      expect(run.latest().state).toBe("failed");
      expect(run.latest().lessons[0].issue).toMatchObject({
        step: "render",
        phase: "synthesize 3/40",
      });
      expect(run.steps).toEqual(["narrate a", "render a"]);

      // Resume narrates what is left first, as a fresh start does.
      await run.runner.start();

      expect(run.latest().state).toBe("finished");
      expect(run.steps.slice(2)).toEqual(["narrate a", "narrate b", "render a", "render b"]);
    });

    it("stops in the middle of the pass without rendering anything", async () => {
      const run = harness({
        renders: {},
        duringNarration: (slug) => {
          if (slug === "b") runnerRef.current?.requestStop();
        },
      });

      await run.runner.start({ lessons: three, settings: narrateFirst, thumbnails: new Map() });

      expect(run.latest().state).toBe("stopped");
      expect(run.latest().lessons.map((lesson) => lesson.status)).toEqual([
        "queued",
        "queued",
        "queued",
      ]);
      expect(run.steps).toEqual(["narrate a", "narrate b"]);
      expect(run.narrationStates.at(-1)).toEqual({ active: null, ready: ["a"], stopped: null });
    });

    it("narrates as it renders where the browser cannot keep narration", async () => {
      const run = harness({
        renders: { a: [passed("A")], b: [passed("B")] },
        narrations: { a: [{ outcome: "cache-unavailable", reason: "Quota exceeded." }] },
      });

      await run.runner.start({
        lessons: unillustrated,
        settings: narrateFirst,
        thumbnails: new Map(),
      });

      expect(run.latest().state).toBe("finished");
      // No second pass: what it synthesized could not be kept for the renders.
      expect(run.steps).toEqual(["narrate a", "render a", "render b"]);
      expect(run.narrationStates.at(-1)?.stopped).toEqual({
        slug: "a",
        reason: "cache-unavailable",
        message: "Quota exceeded.",
      });
    });

    it("narrates only the lessons that still render", async () => {
      const run = harness({
        renders: { a: [passed("A")], b: [passed("B")] },
        publishFailures: 1,
      });

      await run.runner.start({
        lessons: unillustrated,
        settings: narrateFirst,
        thumbnails: new Map(),
      });
      // Stopped at a's publish: a has its draft, b has not rendered.
      expect(run.latest().state).toBe("failed");
      run.steps.length = 0;

      await run.runner.start();

      expect(run.latest().state).toBe("finished");
      expect(run.steps).toEqual(["narrate b", "render b"]);
    });
  });
});
