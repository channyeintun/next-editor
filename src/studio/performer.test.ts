import { describe, expect, it } from "vite-plus/test";
import type { StudioDriver } from "./driver";
import { RENDER_CANCELLED_MESSAGE, StudioActionError, abortableSleep } from "./async";
import { parseStudioPlan, type StudioPlan, type StudioPlanAction } from "./plan";
import { actionAwaitsRuntimeStart, performPlan, performsInBackground } from "./performer";

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
    async pointConsole({ target }) {
      calls.push(`point:${target.text}`);
      return {};
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
    async expandRuntimeDock() {
      calls.push("runtime-expand-dock");
      return { expanded: true };
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

  it("hands a late pointer move's lateness back out of its budget, pressing as planned", async () => {
    const { plan: base, driver } = makePlan();
    const moves: { durationMs: number; press?: boolean }[] = [];
    driver.moveCursor = async ({ durationMs, press }) => {
      moves.push({ durationMs, press });
      return {};
    };
    const plan = parseStudioPlan({
      ...base,
      actions: [
        {
          id: "cursor-run",
          type: "cursor.moveTo",
          at: 0,
          timeoutMs: 1_000,
          target: { kind: "run-button" },
          durationMs: 1_000,
          press: true,
        },
        { id: "c-run", type: "runtime.run", at: 1_080, timeoutMs: 1_000 },
      ],
    });
    // The clock already reads 400ms when the move comes up: a slow action ran
    // over the time the move was planned for.
    const origin = performance.now() - 400;
    const controller = new AbortController();

    await performPlan({
      plan,
      driver,
      clock: { nowMs: () => performance.now() - origin },
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(moves).toHaveLength(1);
    expect(moves[0].press).toBe(true);
    expect(moves[0].durationMs).toBeLessThanOrEqual(600);
    expect(moves[0].durationMs).toBeGreaterThan(500);
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

  it("budgets a drawn whiteboard.apply's frames into its deadline", async () => {
    const { plan, driver } = makePlan();
    // The driver sleeps one 50ms frame per drawn step — at least one per
    // asset — before acknowledging, so ten assets drawn over a short drawMs
    // legitimately outlast the bare 50ms timeout.
    const drawingDriver: StudioDriver = {
      ...driver,
      applyWhiteboard: () => new Promise((resolve) => window.setTimeout(() => resolve({}), 300)),
    };
    const upsertIds = Array.from({ length: 10 }, (_, index) => `asset-${index}`);
    const controller = new AbortController();

    const result = await performPlan({
      plan: {
        ...plan,
        actions: [
          {
            id: "draw",
            type: "whiteboard.apply",
            at: 0,
            timeoutMs: 50,
            open: true,
            maximized: false,
            upsertIds,
            clear: false,
            drawMs: 40,
          },
        ],
      },
      driver: drawingDriver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.error).toBeNull();
    expect(result.status).toBe("completed");
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

const WEB_CONTAINER_WORKSPACE = {
  lessonType: "typescript",
  name: "Preview",
  entryFilePath: "src/main.ts",
  files: { "package.json": "{}", "package-lock.json": "{}", "src/main.ts": "export {};\n" },
};
const WEB_CONTAINER_RUNTIME = {
  kind: "webcontainer",
  adapterVersion: 1,
  defaultMode: "live",
  initCommand: "npm ci",
  runCommand: "npm run dev",
  expectedPort: 5173,
  lockfilePath: "package-lock.json",
  environment: {},
};
const PYTHON_WORKSPACE = {
  lessonType: "python",
  name: "Python",
  entryFilePath: "main.py",
  files: { "main.py": "print('ok')\n" },
};
const PYTHON_RUNTIME = {
  kind: "webcontainer",
  adapterVersion: 1,
  defaultMode: "live",
  initCommand: "",
  runCommand: "python3 main.py",
  environment: {},
};
const NO_RETRY = { maxAttempts: 1, delayMs: 0 };

function makeRuntimePlan(
  actions: Record<string, unknown>[],
  {
    python = false,
    dependencies,
  }: { python?: boolean; dependencies?: Record<string, string> } = {},
): StudioPlan {
  return parseStudioPlan({
    schemaVersion: 1,
    lesson: { slug: "background-start", title: "Background start", locale: "en-US" },
    seed: 7,
    workspace: python ? PYTHON_WORKSPACE : WEB_CONTAINER_WORKSPACE,
    narration: {
      audioPath: "/x.m4a",
      mimeType: "audio/mp4",
      expectedDurationMs: 5_000,
      captions: { id: "c", language: "en", cues: [{ start: 0, end: 1_000, text: "hi" }] },
    },
    runtime: python ? PYTHON_RUNTIME : WEB_CONTAINER_RUNTIME,
    ...(dependencies ? { dependencies } : {}),
    actions,
  });
}

function startAction(at: number, timeoutMs = 2_000) {
  return { id: "start", type: "runtime.start", at, timeoutMs, retry: NO_RETRY };
}
function boardAction(id: string, at: number) {
  return { id, type: "whiteboard.apply", at, timeoutMs: 1_000, open: true };
}

/** A driver whose runtime.start settles `startMs` after it is called. */
function slowStartDriver(startMs: number, outcome: "ok" | "fail" | "hang" = "ok") {
  const { calls, driver } = makePlan();
  driver.startRuntime = () => {
    calls.push("runtime-start");
    if (outcome === "hang") return new Promise(() => {});
    return new Promise((resolve, reject) => {
      window.setTimeout(() => {
        calls.push("runtime-start-settled");
        if (outcome === "fail") reject(new StudioActionError("pnpm install exploded"));
        else resolve({ status: "starting" });
      }, startMs);
    });
  };
  return { calls, driver };
}

describe("performPlan with a background runtime.start", () => {
  it("keeps whiteboard and editor actions on time while the runtime installs", async () => {
    const { calls, driver } = slowStartDriver(400);
    const plan = makeRuntimePlan([
      startAction(0),
      boardAction("draw", 40),
      {
        id: "type",
        type: "editor.type",
        at: 80,
        timeoutMs: 1_000,
        path: "src/main.ts",
        anchor: { after: "", occurrence: 1 },
        chunks: [{ delayMs: 5, text: "x" }],
      },
      { id: "ready", type: "runtime.waitForReady", at: 120, timeoutMs: 1_000, retry: NO_RETRY },
    ]);
    const controller = new AbortController();
    const progress: string[] = [];

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
      onProgress: (receipt) => progress.push(receipt.actionId),
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      "runtime-start",
      "whiteboard:",
      "type:src/main.ts",
      "runtime-start-settled",
      "runtime-ready",
    ]);
    const byId = Object.fromEntries(result.receipts.map((receipt) => [receipt.actionId, receipt]));
    // The board and the typing start at their own times, not after the install.
    expect(byId.draw.startedAtMs!).toBeLessThan(300);
    expect(byId.type.startedAtMs!).toBeLessThan(300);
    // The runtime action waits, and its receipt says when it really started.
    expect(byId.ready.startedAtMs!).toBeGreaterThanOrEqual(byId.start.endedAtMs!);
    expect(byId.start).toMatchObject({ status: "ok", detail: { status: "starting" } });
    expect(byId.start.endedAtMs! - byId.start.startedAtMs!).toBeGreaterThanOrEqual(390);
    // Progress reports the start when it lands; the result keeps plan order.
    expect(progress).toEqual(["draw", "type", "start", "ready"]);
    expect(result.receipts.map((receipt) => receipt.actionId)).toEqual([
      "start",
      "draw",
      "type",
      "ready",
    ]);
  });

  it("holds an action authored afterAction the start until the start acknowledges", async () => {
    const { calls, driver } = slowStartDriver(200);
    const plan = makeRuntimePlan([startAction(0), boardAction("after-start", 10)], {
      dependencies: { "after-start": "start" },
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
    expect(calls).toEqual(["runtime-start", "runtime-start-settled", "whiteboard:"]);
  });

  it("fails the render with the start's error at the runtime action waiting for it", async () => {
    const { calls, driver } = slowStartDriver(150, "fail");
    const plan = makeRuntimePlan([
      startAction(0),
      boardAction("draw", 10),
      { id: "ready", type: "runtime.waitForReady", at: 20, timeoutMs: 1_000, retry: NO_RETRY },
      boardAction("later", 30),
    ]);
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
    expect(result.error).toMatch(/WebContainer startup failed|pnpm install exploded/);
    expect(calls).not.toContain("runtime-ready");
    expect(result.receipts.map((receipt) => [receipt.actionId, receipt.status])).toEqual([
      ["start", "failed"],
      ["draw", "ok"],
      ["ready", "skipped"],
      ["later", "skipped"],
    ]);
    expect(result.receipts[0].error).toMatch(/pnpm install exploded/);
    expect(result.receipts[0].endedAtMs).not.toBeNull();
    expect(abortReasons).toHaveLength(1);
    expect(abortReasons[0]).toMatch(/"start" failed/);
  });

  it("fails the render before the perform phase ends when nothing waits on a failing start", async () => {
    const { driver } = slowStartDriver(150, "fail");
    const plan = makeRuntimePlan([boardAction("draw", 0), startAction(5)]);
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/pnpm install exploded/);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(["ok", "failed"]);
    expect(controller.signal.aborted).toBe(true);
  });

  it("fails a start that outlives its own deadline even while nothing waits on it", async () => {
    const { driver } = slowStartDriver(0, "hang");
    const plan = makeRuntimePlan([startAction(0, 100), boardAction("draw", 10)]);
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/"start" did not acknowledge within 100ms/);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(["failed", "ok"]);
  });

  it("stops waiting cleanly when the render is cancelled mid-install", async () => {
    for (const actions of [
      // Cancelled while a runtime action waits on the start…
      [
        startAction(0, 30_000),
        { id: "ready", type: "runtime.waitForReady", at: 10, timeoutMs: 1_000, retry: NO_RETRY },
      ],
      // …and while the perform phase waits on it at the end.
      [startAction(0, 30_000), boardAction("draw", 10)],
    ]) {
      const { driver } = slowStartDriver(0, "hang");
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(), 80);
      const before = performance.now();

      const result = await performPlan({
        plan: makeRuntimePlan(actions),
        driver,
        clock: makeClock(),
        signal: controller.signal,
        abort: () => controller.abort(),
      });

      expect(performance.now() - before).toBeLessThan(1_000);
      expect(result.status).toBe("failed");
      expect(result.error).toBe(RENDER_CANCELLED_MESSAGE);
      expect(result.receipts[0]).toMatchObject({
        actionId: "start",
        status: "failed",
        error: RENDER_CANCELLED_MESSAGE,
      });
      expect(result.receipts).toHaveLength(2);
    }
  });

  it("records an action the failing start interrupted as skipped, not failed", async () => {
    const { calls, driver } = slowStartDriver(100, "fail");
    // An editor.type still typing when the start fails: the abort cancels it
    // under its feet, but the start is the one causal failure.
    const plan = makeRuntimePlan([
      startAction(0),
      {
        id: "type",
        type: "editor.type",
        at: 10,
        timeoutMs: 5_000,
        path: "src/main.ts",
        anchor: { after: "", occurrence: 1 },
        chunks: [{ delayMs: 5, text: "x" }],
      },
      boardAction("later", 20),
    ]);
    const controller = new AbortController();
    // Like the real driver, typing honours the render's shared signal.
    driver.typeText = async () => {
      calls.push("type-started");
      await abortableSleep(5_000, controller.signal);
      return {};
    };

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(calls).toContain("type-started");
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/pnpm install exploded/);
    expect(result.receipts.map((receipt) => [receipt.actionId, receipt.status])).toEqual([
      ["start", "failed"],
      ["type", "skipped"],
      ["later", "skipped"],
    ]);
    expect(result.receipts[1].error).toMatch(/pnpm install exploded/);
    expect(result.receipts[1].startedAtMs).not.toBeNull();
  });

  it("keeps a Python start in the foreground: it is the run, so later edits wait for it", async () => {
    const { calls, driver } = slowStartDriver(200);
    const plan = makeRuntimePlan(
      [
        startAction(0),
        {
          id: "type",
          type: "editor.type",
          at: 10,
          timeoutMs: 1_000,
          path: "main.py",
          anchor: { after: "", occurrence: 1 },
          chunks: [{ delayMs: 5, text: "#" }],
        },
        { id: "out", type: "expect.output", at: 20, timeoutMs: 1_000, contains: "ok" },
      ],
      { python: true },
    );
    const controller = new AbortController();

    const result = await performPlan({
      plan,
      driver,
      clock: makeClock(),
      signal: controller.signal,
      abort: () => controller.abort(),
    });

    expect(result.status).toBe("completed");
    expect(calls).toEqual(["runtime-start", "runtime-start-settled", "type:main.py", "wait:ok"]);
  });
});

describe("actionAwaitsRuntimeStart", () => {
  const plan = makeRuntimePlan([startAction(0)]);
  const base = plan.actions[0];
  const of = (action: Record<string, unknown>) =>
    actionAwaitsRuntimeStart({ ...base, ...action } as StudioPlanAction);

  it("holds every action that talks to the runtime, its output or its preview", () => {
    for (const type of [
      "runtime.start",
      "runtime.waitForReady",
      "runtime.run",
      "console.point",
      "expect.output",
      "preview.open",
      "preview.click",
      "preview.input",
      "preview.scroll",
      "preview.route",
      "expect.preview",
    ]) {
      expect({ type, awaits: of({ type }) }).toEqual({ type, awaits: true });
    }
    expect(of({ type: "cursor.moveTo", target: { kind: "preview", testId: "go" } })).toBe(true);
  });

  it("lets the stage, the editor and the dock carry on", () => {
    for (const type of [
      "workspace.openFile",
      "editor.type",
      "editor.select",
      "slide.show",
      "slide.close",
      "whiteboard.apply",
      "expect.file",
      "runtime.collapseDock",
      "runtime.expandDock",
    ]) {
      expect({ type, awaits: of({ type }) }).toEqual({ type, awaits: false });
    }
    expect(of({ type: "cursor.moveTo", target: { kind: "run-button" } })).toBe(false);
    expect(of({ type: "cursor.moveTo", target: { kind: "editor" } })).toBe(false);
  });

  it("runs only a server-style runtime.start in the background", () => {
    expect(performsInBackground(base, plan)).toBe(true);
    expect(
      performsInBackground({ ...base, type: "runtime.waitForReady" } as StudioPlanAction, plan),
    ).toBe(false);
    // A Python start is the one-shot program run itself.
    expect(performsInBackground(base, makeRuntimePlan([startAction(0)], { python: true }))).toBe(
      false,
    );
  });
});
