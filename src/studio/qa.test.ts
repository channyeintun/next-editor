import { describe, expect, it } from "vite-plus/test";
import type { Recording } from "../core/src";
import { encodeRecordingToStream } from "../storage/recordingCodec";
import { parseStudioPlan, type StudioPlan } from "./plan";
import { runArtifactChecks } from "./qa";

const DURATION_MS = 5_000;

function makePlan(): StudioPlan {
  return parseStudioPlan({
    schemaVersion: 1,
    lesson: { slug: "qa-test", title: "QA test", locale: "en-US" },
    seed: 1,
    workspace: {
      lessonType: "go",
      name: "T",
      entryFilePath: "main.go",
      files: { "main.go": "package main\n" },
    },
    narration: {
      audioPath: "/x.m4a",
      mimeType: "audio/mp4",
      expectedDurationMs: DURATION_MS,
      captions: {
        id: "studio-narration",
        language: "en",
        cues: [
          { start: 0, end: 1_500, text: "hello" },
          { start: 1_500, end: 4_500, text: "world" },
        ],
      },
    },
    runtime: {
      kind: "go-playground",
      defaultMode: "fixture",
      fixture: { latencyMs: 10, result: { status: "success", output: "ok\n", exitCode: 0 } },
    },
    actions: [
      { id: "open", type: "workspace.openFile", at: 10, timeoutMs: 1_000, path: "main.go" },
      { id: "out", type: "expect.output", at: 20, timeoutMs: 1_000, contains: "3 cubed is 27" },
      {
        id: "file",
        type: "expect.file",
        at: 20,
        timeoutMs: 1_000,
        path: "main.go",
        contains: "cube",
      },
    ],
  });
}

function makeRecording(plan: StudioPlan): Recording {
  const selection = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
    selectionStartLineNumber: 1,
    selectionStartColumn: 1,
    positionLineNumber: 1,
    positionColumn: 1,
  };
  const runtimeSnapshot = {
    mode: "single-file" as const,
    status: "idle",
    activeTab: "runner" as const,
    isCollapsed: false,
    isFullHeight: false,
    isSettingsOpen: false,
    consoleLines: ["[go-run] go run main.go", "3 cubed is 27", "[go-run] Program exited"],
    terminalScrollLines: {},
  };
  const project = {
    id: "studio-qa-test",
    name: "T",
    lessonType: "go" as const,
    entryFilePath: "main.go",
    folders: [],
    files: {
      "main.go": {
        path: "main.go",
        name: "main.go",
        language: "go",
        content: "package main\n// cube\n",
      },
    },
  };

  return {
    version: 4,
    id: "qa-test-recording",
    name: "QA test recording",
    createdAt: Date.now(),
    duration: DURATION_MS,
    keyframeInterval: 120,
    frames: [
      {
        timestamp: 0,
        isKeyframe: true,
        state: {
          content: "package main\n",
          selection,
          position: { lineNumber: 1, column: 1 },
          viewState: null,
        },
      },
      {
        timestamp: 1_000,
        isKeyframe: false,
      },
    ],
    cursorEvents: [
      { timestamp: 0, x: 0, y: 0, visible: false },
      { timestamp: 900, x: 10, y: 10, visible: true },
    ],
    workspaceEvents: [{ timestamp: 0, snapshot: { project, activeFilePath: "main.go" } }],
    runtimeEvents: [{ timestamp: 1_200, snapshot: runtimeSnapshot }],
    tracks: [
      { id: "editor-1", kind: "editor" },
      { id: "audio-1", kind: "audio", source: "external" },
      { id: "workspace-1", kind: "workspace" },
      { id: "runtime-1", kind: "runtime" },
      { id: "cursor-1", kind: "cursor" },
    ],
    captions: [plan.narration.captions],
    audioSource: "external",
    audioFile: "lesson-qa-test.m4a",
    audioStartOffsetMs: 0,
    streamFinalized: true,
    workspaceSnapshot: { project, activeFilePath: "main.go" },
    runtimeSnapshot,
  };
}

function makePreviewPlan(): StudioPlan {
  return parseStudioPlan({
    schemaVersion: 1,
    lesson: { slug: "preview-qa-test", title: "Preview QA test", locale: "en-US" },
    seed: 2,
    workspace: {
      lessonType: "typescript",
      name: "Preview",
      entryFilePath: "src/main.ts",
      files: {
        "package.json": '{"scripts":{"dev":"vite --host 0.0.0.0"}}',
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "src/main.ts": "document.body.textContent = 'Ready';\n",
      },
    },
    narration: {
      audioPath: "/preview.m4a",
      mimeType: "audio/mp4",
      expectedDurationMs: DURATION_MS,
      captions: {
        id: "studio-narration",
        language: "en",
        cues: [{ start: 0, end: 4_500, text: "preview" }],
      },
    },
    runtime: {
      kind: "webcontainer",
      adapterVersion: 1,
      defaultMode: "live",
      initCommand: "pnpm install --frozen-lockfile",
      runCommand: "pnpm dev",
      expectedPort: 5173,
      lockfilePath: "pnpm-lock.yaml",
      environment: {},
    },
    actions: [
      {
        id: "start",
        type: "runtime.start",
        at: 10,
        timeoutMs: 1_000,
        retry: { maxAttempts: 1, delayMs: 0 },
      },
      {
        id: "ready",
        type: "runtime.waitForReady",
        at: 20,
        timeoutMs: 1_000,
        retry: { maxAttempts: 2, delayMs: 10 },
      },
      {
        id: "open-preview",
        type: "preview.open",
        at: 30,
        timeoutMs: 1_000,
        mode: "docked",
        retry: { maxAttempts: 2, delayMs: 10 },
      },
      {
        id: "submit",
        type: "preview.click",
        at: 40,
        timeoutMs: 1_000,
        target: { by: "testId", value: "submit" },
        retry: { maxAttempts: 1, delayMs: 0 },
      },
      {
        id: "assert-result",
        type: "expect.preview",
        at: 50,
        timeoutMs: 1_000,
        target: { by: "testId", value: "result" },
        textContains: "Saved",
        route: "/done",
        retry: { maxAttempts: 2, delayMs: 10 },
      },
    ],
  });
}

function makePreviewRecording(plan: StudioPlan): Recording {
  const recording = makeRecording(plan);
  recording.tracks = [...(recording.tracks ?? []), { id: "preview-1", kind: "preview" }];
  recording.previewEvents = [
    {
      type: "preview_open",
      timestamp: 30,
      isOpen: true,
      mode: "docked",
      size: "small",
    },
    {
      type: "preview_interaction",
      timestamp: 40,
      interaction: {
        type: "click",
        timestamp: 40,
        target: { tagName: "button", testId: "submit", xpath: "/html/body/button" },
      },
    },
    { type: "preview_route_change", timestamp: 45, route: "/done" },
    {
      type: "preview_checkpoint",
      timestamp: 50,
      checkpoint: {
        actionId: "assert-result",
        route: "/done",
        target: {
          attributes: { "data-testid": "result" },
          tagName: "output",
          testId: "result",
          text: "Saved",
          value: null,
        },
      },
    },
  ];
  recording.previewInitialDocuments = [
    {
      version: 2,
      time: 35,
      documentId: "document-1",
      route: "/",
      events: [
        { type: 4, data: {}, timestamp: 1_000 },
        { type: 2, data: {}, timestamp: 1_001 },
      ],
    },
  ];
  recording.previewPatchBatches = [
    {
      version: 2,
      time: 40,
      source: "runtime-preview",
      documentId: "document-1",
      route: "/done",
      events: [{ type: 3, data: {}, timestamp: 1_010 }],
    },
  ];
  return recording;
}

async function checksFor(recording: Recording, plan: StudioPlan) {
  const neBytes = await encodeRecordingToStream(recording);
  return runArtifactChecks({ recording, neBytes, plan });
}

function failedIds(checks: { id: string; ok: boolean }[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.id);
}

describe("runArtifactChecks", () => {
  it("passes a well-formed artifact", async () => {
    const plan = makePlan();
    const checks = await checksFor(makeRecording(plan), plan);
    expect(failedIds(checks)).toEqual([]);
  });

  it("fails on a non-finite duration", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.duration = Number.NaN;
    const checks = await runArtifactChecks({
      recording,
      neBytes: await encodeRecordingToStream(makeRecording(plan)),
      plan,
    });
    expect(failedIds(checks)).toContain("duration.finite");
  });

  it("fails on regressing cursor timestamps", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.cursorEvents = [
      { timestamp: 900, x: 1, y: 1, visible: true },
      { timestamp: 100, x: 2, y: 2, visible: true },
    ];
    const checks = await checksFor(recording, plan);
    expect(failedIds(checks)).toContain("cursor.monotonic");
  });

  it("fails when required tracks are missing", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.tracks = recording.tracks!.filter((track) => track.kind !== "runtime");
    const checks = await checksFor(recording, plan);
    expect(failedIds(checks)).toContain("tracks.required");
  });

  it("fails when the recorded console carries an error line", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.runtimeSnapshot!.consoleLines = [
      "[go-run] go run main.go",
      "[go-run error] Build failed",
    ];
    const checks = await checksFor(recording, plan);
    expect(failedIds(checks)).toContain("runtime.noErrors");
    expect(failedIds(checks)).toContain("checkpoint.output.out");
  });

  it("fails when a semantic file checkpoint is missing", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.workspaceSnapshot!.project.files["main.go"] = {
      path: "main.go",
      name: "main.go",
      language: "go",
      content: "package main\n",
    };
    const checks = await checksFor(recording, plan);
    expect(failedIds(checks)).toContain("checkpoint.file.file");
  });

  it("fails when the caption track is missing", async () => {
    const plan = makePlan();
    const recording = makeRecording(plan);
    recording.captions = [];
    const checks = await checksFor(recording, plan);
    expect(failedIds(checks)).toContain("captions.attached");
  });

  it("passes preview records, replay data, interactions, and DOM checkpoints", async () => {
    const plan = makePreviewPlan();
    expect(failedIds(await checksFor(makePreviewRecording(plan), plan))).toEqual([]);
  });

  it("fails a corrupt preview checkpoint with a diagnostic screenshot", async () => {
    const plan = makePreviewPlan();
    const recording = makePreviewRecording(plan);
    recording.previewEvents!.at(-1)!.checkpoint!.target!.text = "Not saved";
    const checks = await runArtifactChecks({
      recording,
      neBytes: await encodeRecordingToStream(recording),
      plan,
      capturePreviewScreenshot: async () => ({
        dataUrl: "data:image/png;base64,cHJldmlldw==",
        height: 480,
        width: 640,
      }),
    });
    const checkpoint = checks.find((check) => check.id === "checkpoint.preview.assert-result");
    expect(checkpoint?.ok).toBe(false);
    expect(checkpoint?.diagnostic?.previewScreenshot).toMatchObject({ width: 640, height: 480 });
  });

  it("fails when preview replay data or preview error state is missing", async () => {
    const plan = makePreviewPlan();
    const recording = makePreviewRecording(plan);
    recording.previewPatchBatches = [];
    recording.runtimeSnapshot!.latestPreviewMessage = {
      id: 1,
      kind: "uncaught-exception",
      text: "boom",
      port: 5173,
      pathname: "/",
    };
    const checks = await checksFor(recording, plan);
    const failed = failedIds(checks);
    expect(failed).toContain("preview.records.required");
    expect(failed).toContain("preview.replayData");
    expect(failed).toContain("preview.noErrors");
  });
});
