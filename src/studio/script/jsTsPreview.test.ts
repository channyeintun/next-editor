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
