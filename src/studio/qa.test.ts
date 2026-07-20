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
});
