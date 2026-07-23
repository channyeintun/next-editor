import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vite-plus/test";
import { compileLessonScript, type CompileInput } from "./compile";
import { splitIntoDialogs } from "./dialogs";
import { LEXICON_V1 } from "./lexicon";
import { extractNarration } from "./markers";
import { scheduleDialogs } from "./schedule";
import { parseLessonScript, type LessonScript } from "./schema";
import { computeTimingStats, timingGateCheck, type ActionReceipt } from "../report";

const FIXTURE_ROOT = resolve(__dirname, "./__fixtures__");

function loadFixture(name: string): LessonScript {
  return parseLessonScript(YAML.parse(readFileSync(resolve(FIXTURE_ROOT, name), "utf8")));
}

function scheduledInputFor(script: LessonScript): CompileInput {
  const extracted = extractNarration(
    script.scenes.map((scene) => ({ sceneId: scene.id, narration: scene.narration })),
  );
  const dialogs = splitIntoDialogs(extracted);
  const schedule = scheduleDialogs({
    script,
    extracted,
    dialogs,
    durationsMs: dialogs.map((dialog) => 500 + dialog.tokens.length * 280),
    lexicon: LEXICON_V1,
  });
  return {
    script,
    extracted,
    alignment: schedule.alignment,
    narration: {
      audioPath: "studio-tts://js-ts-preview-test",
      mimeType: "audio/wav",
      durationMs: schedule.totalDurationMs,
    },
  };
}

describe("JavaScript and TypeScript Studio fixtures", () => {
  it("compiles the minimal JavaScript fixture with the required runtime contract", () => {
    const script = loadFixture("javascript-minimal.yaml");
    const { plan } = compileLessonScript(scheduledInputFor(script));

    expect(plan.workspace.lessonType).toBe("javascript");
    expect(plan.runtime).toMatchObject({
      kind: "webcontainer",
      adapterVersion: 1,
      lockfilePath: "package-lock.json",
    });
    expect(
      plan.actions.filter((action) => action.type !== "cursor.moveTo").map((action) => action.type),
    ).toEqual(["workspace.openFile", "editor.type", "expect.file"]);
  });

  it("compiles the pinned TypeScript/Vite interaction fixture end to end", () => {
    const script = loadFixture("typescript-vite-preview.yaml");
    const packageJson = JSON.parse(script.lesson.workspace.files["package.json"]);
    const packageLock = JSON.parse(script.lesson.workspace.files["package-lock.json"]);
    const { plan } = compileLessonScript(scheduledInputFor(script));

    expect(packageJson.devDependencies).toEqual({ vite: "5.4.21" });
    expect(packageLock.dependencies.vite).toMatchObject({
      version: "5.4.21",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(plan.runtime).toEqual({
      kind: "webcontainer",
      adapterVersion: 1,
      defaultMode: "live",
      initCommand: "npm ci --no-audit --no-fund",
      runCommand: "npm run dev",
      expectedPort: 5173,
      lockfilePath: "package-lock.json",
      environment: {},
    });
    expect(plan.actions.map((action) => action.type)).toEqual([
      "runtime.start",
      "runtime.waitForReady",
      "preview.open",
      "preview.input",
      "preview.click",
      "expect.preview",
    ]);
    const expectation = plan.actions.at(-1);
    expect(expectation).toMatchObject({
      type: "expect.preview",
      target: { by: "testId", value: "greeting" },
      textContains: "Hello, Ada!",
      route: "/hello?name=Ada",
      attribute: { name: "data-state", value: "ready" },
    });
  });

  it("emits explicit afterAction dependencies and a timing gate (STUDIO-03)", () => {
    const script = loadFixture("typescript-vite-preview.yaml");
    const { plan } = compileLessonScript(scheduledInputFor(script));
    // The runtime chain and the final assertion are dependency-linked, not
    // pinned to placeholder planned times.
    expect(plan.dependencies).toEqual({
      "wait-for-preview-server": "start-runtime",
      "open-preview": "wait-for-preview-server",
      "expect-greeting": "click-greet",
    });
    // Preview support is no longer qualified by an ungated fixture.
    expect(plan.gates?.timingP95MaxMs).toBe(500);
  });

  it("keeps the timing gate meaningful when WebContainer readiness is delayed (STUDIO-03)", () => {
    const script = loadFixture("typescript-vite-preview.yaml");
    const { plan } = compileLessonScript(scheduledInputFor(script));
    const maxP95 = plan.gates!.timingP95MaxMs!;
    const at = (id: string) => plan.actions.find((action) => action.id === id)!.at;
    const receipt = (id: string, startedAtMs: number, endedAtMs: number): ActionReceipt => ({
      actionId: id,
      actionType: plan.actions.find((action) => action.id === id)!.type,
      status: "ok",
      plannedAtMs: at(id),
      startedAtMs,
      endedAtMs,
    });

    // A dependency install/readiness that fills most of the narration budget
    // between "start the runtime" and the first interaction — far larger than
    // the 500ms gate, yet finishing before the interaction's narration mark.
    const startEnd = at("start-runtime") + 50;
    const readinessMs = Math.max(600, at("fill-name") - startEnd - 200);
    const waitEnd = startEnd + readinessMs;
    const openEnd = waitEnd + 40;
    expect(openEnd).toBeLessThan(at("fill-name")); // readiness lands before the interaction beat

    const receipts: ActionReceipt[] = [
      receipt("start-runtime", at("start-runtime"), startEnd),
      // waitForReady begins the instant start acks, then blocks for the install.
      receipt("wait-for-preview-server", startEnd, waitEnd),
      // open-preview begins the instant readiness lands (its placeholder planned
      // time is the runtime.start mark, seconds earlier).
      receipt("open-preview", waitEnd, openEnd),
      // The mark-anchored interactions run on their narration beats.
      receipt("fill-name", at("fill-name"), at("fill-name") + 40),
      receipt("click-greet", at("click-greet"), at("click-greet") + 20),
      receipt("expect-greeting", at("expect-greeting"), at("expect-greeting") + 10),
    ];

    // With the dependency model, open-preview's drift is measured from when
    // readiness actually landed (~0ms), so the gate passes.
    expect(timingGateCheck(computeTimingStats(receipts, plan.dependencies), maxP95).ok).toBe(true);

    // Without it, the whole readiness wait counts as open-preview start drift and
    // the gate fails by construction — the exact regression STUDIO-03 fixes.
    expect(timingGateCheck(computeTimingStats(receipts), maxP95).ok).toBe(false);
  });

  it("compiles a Python WebContainer lesson (WASI python3, console expect.output)", () => {
    const script = loadFixture("python-console.yaml");
    const { plan } = compileLessonScript(scheduledInputFor(script));

    expect(plan.workspace.lessonType).toBe("python");
    expect(plan.runtime).toMatchObject({ kind: "webcontainer", runCommand: "python3 main.py" });
    // Python omits the lockfile (nothing is installed).
    expect((plan.runtime as { lockfilePath?: string }).lockfilePath).toBeUndefined();
    // Runs one-shot then gates the console — no waitForReady/preview.
    expect(plan.actions.map((action) => action.type)).toEqual(["runtime.start", "expect.output"]);
    expect(plan.dependencies).toEqual({ "expect-cube": "run" });
  });

  it("rejects a Python lesson that reaches for a preview server", () => {
    const withPreview = YAML.parse(
      readFileSync(resolve(FIXTURE_ROOT, "python-console.yaml"), "utf8"),
    );
    withPreview.scenes[0].actions.push({
      id: "open",
      type: "preview.open",
      at: { afterAction: "run" },
      timeoutMs: 5000,
      mode: "docked",
      retry: { maxAttempts: 2, delayMs: 100 },
    });
    expect(() => parseLessonScript(withPreview)).toThrow(/Python runs one-shot to the console/);
  });

  it("rejects Python runtime fields that contradict the console-only contract", () => {
    const invalidRuntimeVariants: Array<[Record<string, unknown>, RegExp]> = [
      [{ lockfilePath: "main.py" }, /must omit lockfilePath/],
      [{ expectedPort: 5173 }, /must omit expectedPort/],
      [{ initCommand: "npm install" }, /empty initCommand/],
      [{ runCommand: "node main.py" }, /must invoke "python3"/],
    ];
    for (const [runtimePatch, message] of invalidRuntimeVariants) {
      const raw = YAML.parse(readFileSync(resolve(FIXTURE_ROOT, "python-console.yaml"), "utf8"));
      Object.assign(raw.runtime, runtimePatch);
      expect(() => parseLessonScript(raw)).toThrow(message);
    }
  });

  it("rejects a JS/TS WebContainer lesson without a lockfile", () => {
    const noLock = YAML.parse(
      readFileSync(resolve(FIXTURE_ROOT, "typescript-vite-preview.yaml"), "utf8"),
    );
    delete noLock.runtime.lockfilePath;
    expect(() => parseLessonScript(noLock)).toThrow(/must pin a lockfilePath/);
  });

  it("rejects omitted runtimes and retryable clicks before render", () => {
    const withoutRuntime = YAML.parse(
      readFileSync(resolve(FIXTURE_ROOT, "javascript-minimal.yaml"), "utf8"),
    );
    delete withoutRuntime.runtime;
    expect(() => parseLessonScript(withoutRuntime)).toThrow(/runtime/);

    const retryableClick = YAML.parse(
      readFileSync(resolve(FIXTURE_ROOT, "typescript-vite-preview.yaml"), "utf8"),
    );
    retryableClick.scenes[0].actions.find(
      (action: { id: string }) => action.id === "click-greet",
    ).retry.maxAttempts = 2;
    expect(() => parseLessonScript(retryableClick)).toThrow(/non-idempotent/);
  });
});
