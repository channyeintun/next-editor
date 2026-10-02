import { describe, expect, it } from "vite-plus/test";
import { studioPlanSchema, type StudioPlanActionType } from "./plan";
import { lessonScriptSchema } from "./script/schema";

/**
 * The runtime contract — which actions each runtime kind allows, and how a
 * WebContainer runtime must be set up — is checked by the script schema and
 * again by the plan schema. Every case below runs through both, so the two
 * cannot give different answers without a test failing. Each case lists every
 * issue the schema reports, in order, so a reworded message fails here too.
 */

type CaseAction = { id: string; type: StudioPlanActionType } & Record<string, unknown>;

interface ContractCase {
  name: string;
  workspace: Record<string, unknown>;
  runtime: Record<string, unknown>;
  actions: CaseAction[];
  issues: string[];
}

const JS_WORKSPACE = {
  lessonType: "javascript",
  name: "JavaScript Lesson",
  entryFilePath: "index.js",
  files: { "package.json": "{}\n", "package-lock.json": "{}\n", "index.js": "console.log(1);\n" },
};
const PYTHON_WORKSPACE = {
  lessonType: "python",
  name: "Python Lesson",
  entryFilePath: "main.py",
  files: { "main.py": "print(1)\n" },
};
const GO_WORKSPACE = {
  lessonType: "go",
  name: "Go Lesson",
  entryFilePath: "main.go",
  files: { "main.go": "package main\n" },
};

const JS_RUNTIME = {
  kind: "webcontainer",
  adapterVersion: 1,
  defaultMode: "live",
  initCommand: "npm ci",
  runCommand: "npm run dev",
  expectedPort: 5173,
  lockfilePath: "package-lock.json",
  environment: {},
};
const PYTHON_RUNTIME = {
  kind: "webcontainer",
  adapterVersion: 1,
  defaultMode: "live",
  initCommand: "",
  runCommand: "python3 main.py",
  environment: {},
};
const GO_RUNTIME = {
  kind: "go-playground",
  defaultMode: "fixture",
  fixture: { latencyMs: 100, result: { status: "success", output: "1\n", exitCode: 0 } },
};
const NO_RUNTIME = { kind: "none" };

const RETRY = { maxAttempts: 2, delayMs: 100 };
const TARGET = { by: "testId", value: "greeting" };

const run: CaseAction = { id: "run", type: "runtime.run" };
const start: CaseAction = { id: "start", type: "runtime.start", retry: RETRY };
const waitForReady: CaseAction = { id: "wait", type: "runtime.waitForReady", retry: RETRY };
const collapseDock: CaseAction = { id: "collapse", type: "runtime.collapseDock" };
const openPreview: CaseAction = {
  id: "open-preview",
  type: "preview.open",
  mode: "docked",
  retry: RETRY,
};
const click: CaseAction = {
  id: "click",
  type: "preview.click",
  target: TARGET,
  retry: { maxAttempts: 1, delayMs: 0 },
};
const input: CaseAction = {
  id: "input",
  type: "preview.input",
  target: TARGET,
  value: "Ada",
  retry: RETRY,
};
const scroll: CaseAction = { id: "scroll", type: "preview.scroll", top: 200, retry: RETRY };
const route: CaseAction = { id: "route", type: "preview.route", route: "/hello", retry: RETRY };
const expectPreview: CaseAction = {
  id: "expect-preview",
  type: "expect.preview",
  target: TARGET,
  textContains: "Hello",
  retry: RETRY,
};
const expectOutput: CaseAction = { id: "expect-output", type: "expect.output", contains: "1" };

const CASES: ContractCase[] = [
  {
    name: "accepts a JavaScript preview lesson",
    workspace: JS_WORKSPACE,
    runtime: JS_RUNTIME,
    actions: [start, waitForReady, openPreview, input, click, scroll, route, expectPreview],
    issues: [],
  },
  {
    name: "accepts a Python console lesson",
    workspace: PYTHON_WORKSPACE,
    runtime: PYTHON_RUNTIME,
    actions: [start, expectOutput],
    issues: [],
  },
  {
    name: "accepts a Playground lesson",
    workspace: GO_WORKSPACE,
    runtime: GO_RUNTIME,
    actions: [run, expectOutput, collapseDock],
    issues: [],
  },
  {
    name: "rejects a runtime kind the lesson type does not use",
    workspace: JS_WORKSPACE,
    runtime: GO_RUNTIME,
    actions: [run],
    issues: ['Lesson type "javascript" requires runtime kind "webcontainer", got "go-playground"'],
  },
  {
    name: "rejects runnable actions on runtime kind none",
    workspace: GO_WORKSPACE,
    runtime: NO_RUNTIME,
    actions: [run, start, waitForReady, openPreview, expectPreview, expectOutput],
    issues: [
      'Lesson type "go" requires runtime kind "go-playground", got "none"',
      'Action "run" (runtime.run) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "start" (runtime.start) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "wait" (runtime.waitForReady) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "open-preview" (preview.open) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "expect-preview" (expect.preview) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "expect-output" (expect.output) needs a runnable runtime, but lesson type "go" has none in the studio yet',
    ],
  },
  {
    name: "rejects a JavaScript lesson without a lockfile",
    workspace: JS_WORKSPACE,
    runtime: { ...JS_RUNTIME, lockfilePath: undefined },
    actions: [start],
    issues: ["A javascript WebContainer lesson must pin a lockfilePath for a reproducible install"],
  },
  {
    name: "rejects a lockfile that is not pinned",
    workspace: JS_WORKSPACE,
    runtime: { ...JS_RUNTIME, lockfilePath: "pnpm-lock.yaml" },
    actions: [start],
    issues: ['WebContainer lockfile "pnpm-lock.yaml" is not in the pinned workspace'],
  },
  {
    name: "rejects Python runtime fields that need a server or an install",
    workspace: PYTHON_WORKSPACE,
    runtime: {
      ...PYTHON_RUNTIME,
      lockfilePath: "requirements.lock",
      expectedPort: 8000,
      initCommand: "pip install flask",
      runCommand: "node main.py",
    },
    actions: [start, expectOutput],
    issues: [
      'WebContainer lockfile "requirements.lock" is not in the pinned workspace',
      "A Python WebContainer lesson must omit lockfilePath (nothing is installed)",
      "A Python WebContainer lesson must omit expectedPort (it has no server)",
      "A Python WebContainer lesson must use an empty initCommand",
      'A Python WebContainer lesson runCommand must invoke "python3"',
    ],
  },
  {
    name: "rejects Playground and console actions in a JavaScript lesson",
    workspace: JS_WORKSPACE,
    runtime: JS_RUNTIME,
    actions: [start, run, expectOutput],
    issues: [
      'Action "run" (runtime.run) is a Playground command; a WebContainer lesson runs via runtime.start',
      'Action "expect-output" (expect.output) is for console runtimes; a javascript preview lesson asserts with expect.preview',
    ],
  },
  {
    name: "rejects Playground and preview actions in a Python lesson",
    workspace: PYTHON_WORKSPACE,
    runtime: PYTHON_RUNTIME,
    actions: [start, run, waitForReady, openPreview, click, input, scroll, route, expectPreview],
    issues: [
      'Action "run" (runtime.run) is a Playground command; a WebContainer lesson runs via runtime.start',
      'Action "wait" (runtime.waitForReady) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "open-preview" (preview.open) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "click" (preview.click) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "input" (preview.input) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "scroll" (preview.scroll) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "route" (preview.route) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "expect-preview" (expect.preview) needs a preview server; Python runs one-shot to the console — assert with expect.output',
    ],
  },
  {
    name: "rejects WebContainer actions in a Playground lesson",
    workspace: GO_WORKSPACE,
    runtime: GO_RUNTIME,
    actions: [run, start, waitForReady, openPreview, click, input, scroll, route, expectPreview],
    issues: [
      'Action "start" (runtime.start) requires runtime kind "webcontainer"',
      'Action "wait" (runtime.waitForReady) requires runtime kind "webcontainer"',
      'Action "open-preview" (preview.open) requires runtime kind "webcontainer"',
      'Action "click" (preview.click) requires runtime kind "webcontainer"',
      'Action "input" (preview.input) requires runtime kind "webcontainer"',
      'Action "scroll" (preview.scroll) requires runtime kind "webcontainer"',
      'Action "route" (preview.route) requires runtime kind "webcontainer"',
      'Action "expect-preview" (expect.preview) requires runtime kind "webcontainer"',
    ],
  },
  {
    name: "rejects a preview click that may retry",
    workspace: JS_WORKSPACE,
    runtime: JS_RUNTIME,
    actions: [start, { ...click, retry: RETRY }],
    issues: ['Action "click" is non-idempotent and must use retry.maxAttempts: 1'],
  },
  {
    name: "rejects preview expectations without a target",
    workspace: JS_WORKSPACE,
    runtime: JS_RUNTIME,
    actions: [
      start,
      { id: "expect-nothing", type: "expect.preview", retry: RETRY },
      { id: "expect-text-only", type: "expect.preview", textContains: "Hello", retry: RETRY },
      {
        id: "expect-text",
        type: "expect.preview",
        route: "/hello",
        textContains: "Hello",
        retry: RETRY,
      },
      { id: "expect-value", type: "expect.preview", route: "/hello", value: "Ada", retry: RETRY },
      {
        id: "expect-attribute",
        type: "expect.preview",
        route: "/hello",
        attribute: { name: "data-state", value: "ready" },
        retry: RETRY,
      },
    ],
    issues: [
      'Action "expect-nothing" must declare a preview target or route expectation',
      'Action "expect-text-only" must declare a preview target or route expectation',
      'Action "expect-text-only" needs a stable target for text, value, or attribute checks',
      'Action "expect-text" needs a stable target for text, value, or attribute checks',
      'Action "expect-value" needs a stable target for text, value, or attribute checks',
      'Action "expect-attribute" needs a stable target for text, value, or attribute checks',
    ],
  },
  {
    name: "rejects duplicate action ids",
    workspace: JS_WORKSPACE,
    runtime: JS_RUNTIME,
    actions: [start, start],
    issues: ['Duplicate action id "start"'],
  },
  {
    // The runtime rules for every action come before the per-action checks.
    name: "reports the runtime rules before the per-action checks",
    workspace: PYTHON_WORKSPACE,
    runtime: PYTHON_RUNTIME,
    actions: [start, { ...click, retry: RETRY }],
    issues: [
      'Action "click" (preview.click) needs a preview server; Python runs one-shot to the console — assert with expect.output',
      'Action "click" is non-idempotent and must use retry.maxAttempts: 1',
    ],
  },
];

function scriptIssues(
  workspace: Record<string, unknown>,
  runtime: Record<string, unknown>,
  actions: CaseAction[],
): string[] {
  const result = lessonScriptSchema.safeParse({
    schemaVersion: 1,
    lesson: { slug: "runtime-contract", title: "Runtime contract", locale: "en-US", workspace },
    build: { voiceProfile: "pocket-alba-v1", seed: 7 },
    runtime,
    scenes: [
      {
        id: "only",
        narration: "One scene.",
        actions: actions.map((action) => ({ ...action, at: { scene: "start" } })),
      },
    ],
    checks: [{ type: "timing.p95Ms", max: 300 }],
  });
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function planIssues(
  workspace: Record<string, unknown>,
  runtime: Record<string, unknown>,
  actions: CaseAction[],
): string[] {
  const result = studioPlanSchema.safeParse({
    schemaVersion: 1,
    lesson: { slug: "runtime-contract", title: "Runtime contract", locale: "en-US" },
    seed: 7,
    workspace,
    narration: {
      audioPath: "studio-tts://runtime-contract",
      mimeType: "audio/wav",
      expectedDurationMs: 60_000,
      captions: {
        id: "studio-narration",
        language: "en",
        cues: [{ start: 0, end: 60_000, text: "One scene." }],
      },
    },
    runtime,
    actions: actions.map((action, index) => ({ ...action, at: 1_000 * (index + 1) })),
  });
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe.each([
  { schema: "script", issuesFor: scriptIssues },
  { schema: "plan", issuesFor: planIssues },
])("$schema schema runtime contract", ({ issuesFor }) => {
  it.each(CASES)("$name", ({ workspace, runtime, actions, issues }) => {
    expect(issuesFor(workspace, runtime, actions)).toEqual(issues);
  });
});

// Only the script schema has this rule today; the plan schema's copy of the
// runtime-"none" list lacks runtime.collapseDock.
describe("script schema runtime contract", () => {
  it("rejects runtime.collapseDock on runtime kind none", () => {
    expect(scriptIssues(GO_WORKSPACE, NO_RUNTIME, [collapseDock])).toEqual([
      'Lesson type "go" requires runtime kind "go-playground", got "none"',
      'Action "collapse" (runtime.collapseDock) needs a runnable runtime, but lesson type "go" has none in the studio yet',
    ]);
  });
});
