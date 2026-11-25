import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { base64ToBytes, bytesToBase64 } from "../shared/base64";
import {
  createStudioAutomation,
  installStudioAutomation,
  studioWaitingFor,
  type StudioAutomationDeps,
  type StudioAutomationRun,
  type StudioReadiness,
} from "./automation";
import type { StudioRunArtifacts } from "./runStudioRender";
import type { StudioWorkflow } from "./workflow/workflowQueue";
import type { NewWorkflowInput, WorkflowStartOptions } from "./workflow/workflowRunner";

vi.mock("@next-editor/infra", () => ({ THUMBNAIL_ACCEPT: "image/png,image/jpeg" }));

const ARTIFACTS = {
  neBlob: new Blob(["ne"], { type: "application/x-next-editor" }),
  audioBlob: new Blob(["ogg"], { type: "audio/ogg" }),
  audioFileName: "lesson-go-error-values.ogg",
  recording: {},
} as unknown as StudioRunArtifacts;

function run(overrides: Partial<StudioAutomationRun> = {}): StudioAutomationRun {
  return {
    slug: "go-error-values",
    title: "Error values",
    current: true,
    report: { planSlug: "go-error-values", outcome: "passed" } as StudioAutomationRun["report"],
    manifest: { planSlug: "go-error-values", planHash: "0" } as StudioAutomationRun["manifest"],
    artifacts: ARTIFACTS,
    ...overrides,
  };
}

/** A studio with nothing loading, nothing running and nothing blocked; tests change one thing. */
function fakeStudio(overrides: Partial<StudioAutomationDeps> = {}) {
  const starts: { fresh?: NewWorkflowInput; options?: WorkflowStartOptions }[] = [];
  const studio: StudioAutomationDeps = {
    waitingFor: null,
    busy: false,
    renderBlockedReason: null,
    renderBlockedReasonOf: () => null,
    workflowBlockedReason: null,
    workflowResumeBlockedReason: null,
    signedIn: true,
    provider: "pocket",
    voice: null,
    screenRecording: false,
    lessons: { status: "ready", source: "abc123", count: 2, error: null },
    lessonOf: (slug) => ({ title: `Title of ${slug}` }),
    titleOf: (slug) => (slug === "go-error-values" ? "Error values" : null),
    render: vi.fn<StudioAutomationDeps["render"]>(),
    latestRun: () => null,
    narrationCoverage: async (slugs) => ({
      lessons: slugs.map((slug) => ({ slug, dialogCount: 4, missingCount: 1 })),
      missingDialogCount: slugs.length,
      missingCharacterCount: 10,
      cacheUnavailable: null,
    }),
    playlists: [{ id: "p1", title: "Go course" }],
    workflow: {
      current: null,
      active: false,
      start: async (fresh, options) => {
        starts.push({ fresh, options });
        options?.onBegin?.(null);
      },
      requestStop: vi.fn<() => void>(),
    },
    findPublishedLesson: vi.fn<StudioAutomationDeps["findPublishedLesson"]>(async () => ({
      found: {
        lessonId: "l1",
        urlSlug: "error-values",
        title: "Error values",
        status: "published" as const,
        duration: "1:00",
      },
    })),
    replacePublishedLesson: vi.fn<StudioAutomationDeps["replacePublishedLesson"]>(async () => ({
      refused: "unused",
    })),
    ...overrides,
  };
  return { studio, starts, automation: createStudioAutomation(() => studio) };
}

const WORKFLOW_SETTINGS = {
  createDraft: true,
  publish: true,
  defaultThumbnailWhenMissing: false,
  playlistId: null,
  narrateFirst: true,
  fullSpeed: true,
};

describe("studioWaitingFor", () => {
  const ready: StudioReadiness = {
    lessons: "ready",
    authLoading: false,
    capabilitiesLoading: false,
    provider: "pocket",
    voxCpm2Enabled: false,
    narratorVoiceReported: true,
    athanLabReported: false,
    howardServerReported: false,
  };

  it("names what the studio still waits for, and nothing once ready", () => {
    expect(studioWaitingFor(ready)).toBeNull();
    expect(studioWaitingFor({ ...ready, lessons: "loading" })).toBe(
      "the list of published lessons",
    );
    // A list that could not be read is settled: the start then says why.
    expect(studioWaitingFor({ ...ready, lessons: "error" })).toBeNull();
    expect(studioWaitingFor({ ...ready, authLoading: true })).toBe("the sign-in state");
    expect(studioWaitingFor({ ...ready, narratorVoiceReported: false })).toBe(
      "the saved narrator voices",
    );
    expect(studioWaitingFor({ ...ready, provider: "voxcpm2" })).toMatch(/VoxCPM2/);
    expect(studioWaitingFor({ ...ready, provider: "athanlab" })).toBe("your AthanLab setup");
    // An answer that blocks a start (an empty balance) is the blocked reason's to say.
    expect(studioWaitingFor({ ...ready, provider: "athanlab", athanLabReported: true })).toBeNull();
    expect(studioWaitingFor({ ...ready, provider: "howard" })).toBe(
      "the Howard server on this computer",
    );
    // A server that did not answer is settled too: the start then says why.
    expect(
      studioWaitingFor({ ...ready, provider: "howard", howardServerReported: true }),
    ).toBeNull();
  });
});

describe("createStudioAutomation", () => {
  it("reports what the studio shows, reading it again on every call", () => {
    const { studio, automation } = fakeStudio({ provider: "athanlab", voice: "Voice A" });
    expect(automation.status()).toMatchObject({
      ready: true,
      provider: "athanlab",
      providerIsPaid: true,
      voice: "Voice A",
      lessons: { status: "ready", source: "abc123", count: 2, error: null },
    });

    studio.waitingFor = "the saved narrator voices";
    studio.provider = "pocket";
    expect(automation.status()).toMatchObject({
      ready: false,
      waitingFor: "the saved narrator voices",
      providerIsPaid: false,
    });

    // Howard runs on the author's computer, like Pocket-TTS.
    studio.provider = "howard";
    expect(automation.status()).toMatchObject({ provider: "howard", providerIsPaid: false });
    studio.provider = "voxcpm2";
    expect(automation.status()).toMatchObject({ providerIsPaid: true });
  });

  describe("startRender", () => {
    it("starts the render the button starts", () => {
      const { studio, automation } = fakeStudio();
      expect(
        automation.startRender({ slug: "go-error-values", runtimeMode: "fixture", speed: "full" }),
      ).toEqual({ started: true });
      expect(studio.render).toHaveBeenCalledWith({
        slug: "go-error-values",
        runtimeMode: "fixture",
        speed: "full",
      });
    });

    it("refuses, naming the reason, when not ready, busy, blocked or asked for nonsense", () => {
      const waiting = fakeStudio({ waitingFor: "the sign-in state" });
      expect(waiting.automation.startRender({ slug: "a" })).toEqual({
        refused: "The studio is not ready: waiting for the sign-in state.",
      });

      const busy = fakeStudio({ busy: true });
      expect(busy.automation.startRender({ slug: "a" })).toEqual({
        refused: "A render or a workflow is running.",
      });

      const blocked = fakeStudio({
        renderBlockedReasonOf: (slug) => `Unknown lesson "${slug}"`,
      });
      expect(blocked.automation.startRender({ slug: "nope" })).toEqual({
        refused: 'Unknown lesson "nope"',
      });

      const odd = fakeStudio();
      expect(odd.automation.startRender({ slug: "a", speed: "warp" as unknown as "full" })).toEqual(
        { refused: 'Unknown speed "warp": expected full or real.' },
      );
      expect(
        odd.automation.startRender({ slug: "a", runtimeMode: "remote" as unknown as "live" }),
      ).toEqual({ refused: 'Unknown runtime mode "remote": expected fixture or live.' });

      for (const studio of [waiting, busy, blocked, odd]) {
        expect(studio.studio.render).not.toHaveBeenCalled();
      }
    });
  });

  describe("latestBundle", () => {
    it("hands over the newest passing run's four files as bytes", async () => {
      const { automation } = fakeStudio({ latestRun: () => run() });
      const files = await automation.latestBundle();

      expect(files?.map((file) => file.name)).toEqual([
        "lesson-go-error-values.ne",
        "lesson-go-error-values.ogg",
        "build-manifest.json",
        "render-report.json",
      ]);
      const text = (base64: string) => new TextDecoder().decode(base64ToBytes(base64));
      expect(text(files![0].base64)).toBe("ne");
      expect(files![1].type).toBe("audio/ogg");
      expect(JSON.parse(text(files![2].base64))).toEqual({
        planHash: "0",
        planSlug: "go-error-values",
      });
      expect(JSON.parse(text(files![3].base64))).toMatchObject({ outcome: "passed" });
    });

    it("is null when there is no run or the newest did not pass", async () => {
      expect(await fakeStudio().automation.latestBundle()).toBeNull();
      const failed = run({
        report: { planSlug: "go-error-values", outcome: "failed" } as StudioAutomationRun["report"],
        artifacts: null,
      });
      expect(await fakeStudio({ latestRun: () => failed }).automation.latestBundle()).toBeNull();
    });
  });

  describe("narrationCoverage", () => {
    it("counts through the studio's coverage", async () => {
      const { automation } = fakeStudio();
      expect(await automation.narrationCoverage(["a"])).toEqual({
        lessons: [{ slug: "a", dialogs: 4, missing: 1 }],
        cacheUnavailable: null,
      });
    });

    it("refuses before the voice is known, and says which lessons it cannot count", async () => {
      expect(
        await fakeStudio({ waitingFor: "the saved narrator voices" }).automation.narrationCoverage([
          "a",
        ]),
      ).toEqual({ refused: "The studio is not ready: waiting for the saved narrator voices." });
      const failing = fakeStudio({
        narrationCoverage: () => Promise.reject(new Error("a: needs Burmese narration")),
      });
      expect(await failing.automation.narrationCoverage(["a"])).toEqual({
        refused: "a: needs Burmese narration",
      });
    });
  });

  describe("startWorkflow", () => {
    it("starts through the shared start rules, with no screen, thumbnails as files and the author's playlist", async () => {
      const { automation, starts } = fakeStudio();
      const started = await automation.startWorkflow({
        slugs: ["go-02-errors", "go-01-basics"],
        settings: { ...WORKFLOW_SETTINGS, playlistId: "p1" },
        thumbnails: [
          { name: "01-basics.png", type: "image/png", base64: bytesToBase64(new Uint8Array([1])) },
          { name: "02-errors.png", type: "image/png", base64: bytesToBase64(new Uint8Array([2])) },
        ],
      });

      expect(started).toEqual({ started: true });
      expect(starts).toHaveLength(1);
      const [{ fresh, options }] = starts;
      expect(options?.recordScreen).toBe(false);
      expect(fresh?.lessons.map((lesson) => [lesson.slug, lesson.title, lesson.thumbnail])).toEqual(
        [
          ["go-01-basics", "Title of go-01-basics", "01-basics.png"],
          ["go-02-errors", "Title of go-02-errors", "02-errors.png"],
        ],
      );
      expect(fresh?.settings).toEqual({
        createDraft: true,
        publish: true,
        defaultThumbnailWhenMissing: false,
        playlist: { id: "p1", title: "Go course" },
        narrateFirst: true,
        fullSpeed: true,
      });
      const thumbnail = fresh?.thumbnails.get("go-01-basics");
      expect(thumbnail).toBeInstanceOf(File);
      expect(new Uint8Array(await thumbnail!.arrayBuffer())).toEqual(new Uint8Array([1]));
    });

    it("refuses with the reason the panel would show", async () => {
      const input = { slugs: ["go-01-basics"], settings: WORKFLOW_SETTINGS, thumbnails: [] };

      const blocked = fakeStudio({ workflowBlockedReason: "A render is running." });
      expect(await blocked.automation.startWorkflow(input)).toEqual({
        refused: "A render is running.",
      });
      expect(await fakeStudio().automation.startWorkflow(input)).toEqual({
        refused: expect.stringMatching(/^1 of 1 lessons have no thumbnail/),
      });
      expect(
        await fakeStudio({ waitingFor: "the sign-in state" }).automation.startWorkflow(input),
      ).toEqual({ refused: "The studio is not ready: waiting for the sign-in state." });
      expect(
        await fakeStudio().automation.startWorkflow({
          ...input,
          settings: { ...WORKFLOW_SETTINGS, defaultThumbnailWhenMissing: true, playlistId: "x" },
        }),
      ).toEqual({ refused: 'The playlist "x" is not one of yours.' });
      expect(
        await fakeStudio({ playlists: null }).automation.startWorkflow({
          ...input,
          settings: { ...WORKFLOW_SETTINGS, defaultThumbnailWhenMissing: true, playlistId: "p1" },
        }),
      ).toEqual({ refused: "Your playlists have not been read yet: try again in a moment." });
      for (const studio of [blocked]) expect(studio.starts).toHaveLength(0);
    });

    it("refuses while a render or a workflow runs, though the blocked reason has not caught up", async () => {
      // A render started a moment ago: React has not rendered it, so the
      // blocked reason still says nothing.
      const busy = fakeStudio({ busy: true });
      expect(
        await busy.automation.startWorkflow({
          slugs: ["go-01-basics"],
          settings: { ...WORKFLOW_SETTINGS, createDraft: false, publish: false },
          thumbnails: [],
        }),
      ).toEqual({ refused: "A render or a workflow is running." });
      expect(busy.starts).toHaveLength(0);
    });

    it("passes on the runner's own refusal", async () => {
      const { automation } = fakeStudio({
        workflow: {
          current: null,
          active: false,
          start: async (_fresh, options) => options?.onBegin?.("Could not keep the thumbnails"),
          requestStop: () => {},
        },
      });
      expect(
        await automation.startWorkflow({
          slugs: ["go-01-basics"],
          settings: { ...WORKFLOW_SETTINGS, createDraft: false, publish: false },
          thumbnails: [],
        }),
      ).toEqual({ refused: "Could not keep the thumbnails" });
    });
  });

  describe("resumeWorkflow and stopWorkflow", () => {
    const stored = (state: StudioWorkflow["state"]) => ({ state }) as StudioWorkflow;

    it("resumes with the resume rules and no screen, and stops", async () => {
      const { studio, automation, starts } = fakeStudio();
      studio.workflow.current = stored("stopped");
      expect(await automation.resumeWorkflow()).toEqual({ started: true });
      expect(starts).toEqual([
        { fresh: undefined, options: expect.objectContaining({ recordScreen: false }) },
      ]);

      automation.stopWorkflow();
      expect(studio.workflow.requestStop).toHaveBeenCalledTimes(1);
    });

    it("refuses while a render or a workflow runs", async () => {
      const { studio, automation, starts } = fakeStudio({ busy: true });
      studio.workflow.current = stored("stopped");
      expect(await automation.resumeWorkflow()).toEqual({
        refused: "A render or a workflow is running.",
      });
      expect(starts).toHaveLength(0);
    });

    it("refuses when there is nothing to resume or it is blocked", async () => {
      const { studio, automation, starts } = fakeStudio({
        workflowResumeBlockedReason: "Finish the narrator voice task first.",
        workflowBlockedReason: "Your AthanLab balance is empty.",
      });
      expect(await automation.resumeWorkflow()).toEqual({
        refused: "There is no workflow to resume.",
      });
      studio.workflow.current = stored("failed");
      expect(await automation.resumeWorkflow()).toEqual({
        refused: "Finish the narrator voice task first.",
      });
      // Built but never run: it starts like a new one.
      studio.workflow.current = stored("ready");
      expect(await automation.resumeWorkflow()).toEqual({
        refused: "Your AthanLab balance is empty.",
      });
      studio.workflow.current = stored("finished");
      expect(await automation.resumeWorkflow()).toEqual({ refused: "The workflow has finished." });
      expect(starts).toHaveLength(0);
    });
  });

  describe("published lessons", () => {
    it("finds the lesson by the script's title", async () => {
      const { studio, automation } = fakeStudio();
      expect(
        await automation.publishedLesson({ slug: "go-error-values", lesson: "x" }),
      ).toMatchObject({ found: { lessonId: "l1" } });
      expect(studio.findPublishedLesson).toHaveBeenCalledWith({
        title: "Error values",
        lesson: "x",
      });
      expect(await automation.publishedLesson({ slug: "nope" })).toEqual({
        refused: 'Unknown lesson "nope".',
      });
    });

    it("replaces with the newest passing run of the current script only", async () => {
      const replace = vi.fn<StudioAutomationDeps["replacePublishedLesson"]>(async () => ({
        compared: {
          lessonId: "l1",
          urlSlug: "error-values",
          changedCues: 1,
          totalCues: 3,
          examples: [],
          publishedDurationMs: 1,
          newDurationMs: 2,
        },
      }));
      const passing = fakeStudio({ latestRun: () => run(), replacePublishedLesson: replace });
      expect(
        await passing.automation.replacePublishedLesson({ lessonId: "l1", replace: false }),
      ).toMatchObject({ compared: { changedCues: 1 } });
      expect(replace).toHaveBeenCalledWith({
        lessonId: "l1",
        run: { title: "Error values", artifacts: ARTIFACTS },
        replace: false,
      });

      const stale = fakeStudio({ latestRun: () => run({ current: false }) });
      expect(
        await stale.automation.replacePublishedLesson({ lessonId: "l1", replace: true }),
      ).toEqual({
        refused:
          'The newest run was made from an older version of "go-error-values": render it again.',
      });
      const failed = fakeStudio({ latestRun: () => run({ artifacts: null }) });
      expect(
        await failed.automation.replacePublishedLesson({ lessonId: "l1", replace: true }),
      ).toEqual({ refused: "The newest run (go-error-values) did not pass: render it again." });
      const signedOut = fakeStudio({ signedIn: false, latestRun: () => run() });
      expect(
        await signedOut.automation.replacePublishedLesson({ lessonId: "l1", replace: true }),
      ).toEqual({ refused: "Sign in first: only your own lessons are replaced." });
      for (const studio of [stale, failed, signedOut]) {
        expect(studio.studio.replacePublishedLesson).not.toHaveBeenCalled();
      }
    });
  });
});

describe("installStudioAutomation", () => {
  const own = Object.getOwnPropertyDescriptor(navigator, "webdriver");
  afterEach(() => {
    if (own) Object.defineProperty(navigator, "webdriver", own);
    else delete (navigator as { webdriver?: boolean }).webdriver;
    delete window.__NEXT_EDITOR_STUDIO__;
  });

  it("is on the handle only in a browser driven by automation", () => {
    const { automation } = fakeStudio();
    installStudioAutomation(automation);
    expect(window.__NEXT_EDITOR_STUDIO__?.automation).toBeUndefined();

    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => true });
    window.__NEXT_EDITOR_STUDIO__ = { runs: [], comparison: null, running: true };
    const remove = installStudioAutomation(automation);
    expect(window.__NEXT_EDITOR_STUDIO__).toMatchObject({ running: true, automation });
    remove();
    expect(window.__NEXT_EDITOR_STUDIO__).toEqual({ runs: [], comparison: null, running: true });
  });

  it("keeps the fields other parts of the studio wrote, and leaves another automation in place", () => {
    Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => true });
    const first = fakeStudio().automation;
    const second = fakeStudio().automation;
    const removeFirst = installStudioAutomation(first);
    window.__NEXT_EDITOR_STUDIO__!.phase = "perform";
    installStudioAutomation(second);
    removeFirst();
    expect(window.__NEXT_EDITOR_STUDIO__).toEqual({
      runs: [],
      comparison: null,
      running: false,
      phase: "perform",
      automation: second,
    });
  });
});
