import { describe, expect, it } from "vite-plus/test";
import type { StudioDriver } from "./driver";
import { StudioActionError } from "./async";
import { parseStudioPlan, type StudioPlan } from "./plan";
import { performPlan } from "./performer";

function makePlan(overrides?: { failRun?: boolean }): {
  plan: StudioPlan;
  calls: string[];
  driver: StudioDriver;
} {
  const calls: string[] = [];
  const driver: StudioDriver = {
    async openFile(path) {
      calls.push(`open:${path}`);
      return { path };
    },
    async typeText({ path }) {
      calls.push(`type:${path}`);
      return { path };
    },
    async moveCursor() {
      calls.push("cursor");
      return {};
    },
    async selectRange({ path, selection }) {
      calls.push(`select:${path}:${selection.text}`);
      return { path };
    },
    async runWorkspace() {
      calls.push("run");
      if (overrides?.failRun) {
        throw new StudioActionError("run exploded");
      }
      return { status: "success" };
    },
    async startRuntime() {
      calls.push("runtime-start");
      return { status: "starting" };
    },
    async waitForRuntimeReady() {
      calls.push("runtime-ready");
      return { status: "ready" };
    },
    async collapseRuntimeDock() {
      calls.push("runtime-collapse-dock");
      return { collapsed: true };
    },
    async openPreview({ mode }) {
      calls.push(`preview-open:${mode}`);
      return { mode };
    },
    async executePreviewCommand({ command }) {
      calls.push(`preview-${command.type}`);
      return { command: command.type };
    },
    async expectPreview({ actionId }) {
      calls.push(`preview-expect:${actionId}`);
      return { actionId };
    },
    async showSlide({ slideId }) {
      calls.push(`slide:${slideId}`);
      return { slideId };
    },
    async closeSlide() {
      calls.push("slide-close");
      return {};
    },
    async applyWhiteboard({ upsertIds }) {
      calls.push(`whiteboard:${upsertIds.join(",")}`);
      return {};
    },
    async waitForOutput({ contains }) {
      calls.push(`wait:${contains}`);
      return { matchedLine: contains };
    },
    async expectFile({ path }) {
      calls.push(`expectFile:${path}`);
      return { path };
    },
    dispose() {},
  };

  const plan = parseStudioPlan({
    schemaVersion: 1,
    lesson: { slug: "performer-test", title: "Performer test", locale: "en-US" },
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
      expectedDurationMs: 5_000,
      captions: {
        id: "c",
        language: "en",
        cues: [{ start: 0, end: 1_000, text: "hi" }],
      },
    },
    runtime: {
      kind: "go-playground",
      defaultMode: "fixture",
      fixture: { latencyMs: 10, result: { status: "success", output: "ok\n", exitCode: 0 } },
    },
    actions: [
      { id: "a-open", type: "workspace.openFile", at: 20, timeoutMs: 1_000, path: "main.go" },
      {
        id: "b-type",
        type: "editor.type",
        at: 60,
        timeoutMs: 1_000,
        path: "main.go",
        anchor: { after: "", occurrence: 1 },
        chunks: [{ delayMs: 5, text: "x" }],
      },
      { id: "c-run", type: "runtime.run", at: 120, timeoutMs: 1_000 },
      { id: "d-out", type: "expect.output", at: 130, timeoutMs: 1_000, contains: "ok" },
    ],
  });

  return { plan, calls, driver };
}

function makeClock() {
  const origin = performance.now();
  return { nowMs: () => performance.now() - origin };
}

describe("performPlan", () => {
  it("runs every action in order at (or after) its planned time", async () => {
    const { plan, calls, driver } = makePlan();
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(calls).toEqual(["open:main.go", "type:main.go", "run", "wait:ok"]);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(["ok", "ok", "ok", "ok"]);
    for (const receipt of result.receipts) {
      expect(receipt.startedAtMs).not.toBeNull();
      // Never meaningfully early; lateness is allowed and recorded. The few
      // milliseconds of slack absorb timer quantization — under a loaded
      // parallel suite a wait has been seen to return 1.1ms before its planned
      // time, which the real gate (timing.p95Ms, 300ms) would never notice.
      expect(receipt.startedAtMs!).toBeGreaterThanOrEqual(receipt.plannedAtMs - 5);
      expect(receipt.endedAtMs!).toBeGreaterThanOrEqual(receipt.startedAtMs!);
    }
  });

  it("dispatches an editor.select through the driver with its resolved range", async () => {
    const { calls, driver } = makePlan();
    const plan = parseStudioPlan({
      schemaVersion: 1,
      lesson: { slug: "select-performer", title: "Select performer", locale: "en-US" },
      seed: 3,
      workspace: {
        lessonType: "go",
        name: "T",
        entryFilePath: "main.go",
        files: { "main.go": "package main\n\nfunc main() {}\n" },
      },
      narration: {
        audioPath: "/x.m4a",
        mimeType: "audio/mp4",
        expectedDurationMs: 5_000,
        captions: { id: "c", language: "en", cues: [{ start: 0, end: 1_000, text: "hi" }] },
      },
      runtime: {
        kind: "go-playground",
        defaultMode: "fixture",
        fixture: { latencyMs: 10, result: { status: "success", output: "ok\n", exitCode: 0 } },
      },
      actions: [
        { id: "open", type: "workspace.openFile", at: 20, timeoutMs: 1_000, path: "main.go" },
        {
          id: "highlight",
          type: "editor.select",
          at: 60,
          timeoutMs: 1_000,
          path: "main.go",
          selection: { text: "func main()", occurrence: 1 },
          durationMs: 400,
        },
      ],
    });
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["open:main.go", "select:main.go:func main()"]);
  });

  it("fails closed: a failing action aborts and skips the rest", async () => {
    const { plan, calls, driver } = makePlan({ failRun: true });
    const controller = new AbortController();
    const abortReasons: string[] = [];

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: (reason) => {
        abortReasons.push(reason);
        controller.abort();
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/run exploded/);
    expect(calls).toEqual(["open:main.go", "type:main.go", "run"]);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual([
      "ok",
      "ok",
      "failed",
      "skipped",
    ]);
    expect(abortReasons[0]).toMatch(/c-run/);
    expect(controller.signal.aborted).toBe(true);
  });

  it("times out an action that never acknowledges", async () => {
    const { plan, driver } = makePlan();
    const hangingDriver: StudioDriver = {
      ...driver,
      openFile: () => new Promise(() => {}),
    };
    const controller = new AbortController();

    const result = await performPlan({
      plan: {
        ...plan,
        actions: [{ ...plan.actions[0], timeoutMs: 50 }],
      },
      driver: hangingDriver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/did not acknowledge within/);
  });

  it("dispatches the authored WebContainer preview sequence through the driver", async () => {
    const { calls, driver } = makePlan();
    const plan = parseStudioPlan({
      schemaVersion: 1,
      lesson: { slug: "preview-performer", title: "Preview performer", locale: "en-US" },
      seed: 29,
      workspace: {
        lessonType: "typescript",
        name: "Preview",
        entryFilePath: "src/main.ts",
        files: {
          "package.json": "{}",
          "package-lock.json": "{}",
          "src/main.ts": "export {};\n",
        },
      },
      narration: {
        audioPath: "/preview.m4a",
        mimeType: "audio/mp4",
        expectedDurationMs: 5_000,
        captions: {
          id: "preview-captions",
          language: "en",
          cues: [{ start: 0, end: 1_000, text: "preview" }],
        },
      },
      runtime: {
        kind: "webcontainer",
        adapterVersion: 1,
        defaultMode: "live",
        initCommand: "npm ci",
        runCommand: "npm run dev",
        expectedPort: 5173,
        lockfilePath: "package-lock.json",
        environment: {},
      },
      actions: [
        {
          id: "start",
          type: "runtime.start",
          at: 0,
          timeoutMs: 1_000,
          retry: { maxAttempts: 1, delayMs: 0 },
        },
        {
          id: "ready",
          type: "runtime.waitForReady",
          at: 0,
          timeoutMs: 1_000,
          retry: { maxAttempts: 1, delayMs: 0 },
        },
        {
          id: "open",
          type: "preview.open",
          at: 0,
          timeoutMs: 1_000,
          mode: "docked",
          retry: { maxAttempts: 1, delayMs: 0 },
        },
        {
          id: "input",
          type: "preview.input",
          at: 0,
          timeoutMs: 1_000,
          target: { by: "testId", value: "name-input" },
          value: "Ada",
          retry: { maxAttempts: 1, delayMs: 0 },
        },
        {
          id: "click",
          type: "preview.click",
          at: 0,
          timeoutMs: 1_000,
          target: { by: "testId", value: "greet-button" },
          retry: { maxAttempts: 1, delayMs: 0 },
        },
        {
          id: "expect",
          type: "expect.preview",
          at: 0,
          timeoutMs: 1_000,
          target: { by: "testId", value: "greeting" },
          textContains: "Hello, Ada!",
          retry: { maxAttempts: 1, delayMs: 0 },
        },
      ],
    });
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "runtime-start",
      "runtime-ready",
      "preview-open:docked",
      "preview-input",
      "preview-click",
      "preview-expect:expect",
    ]);
  });
});
