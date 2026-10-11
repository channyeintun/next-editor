import { describe, expect, it } from "vite-plus/test";
import { studioPlanSchema, type StudioPlanActionType } from "./plan";
import { duplicatePinnedIdIssues, pinnedReferenceIssues } from "./runtimeContract";
import { lessonScriptSchema } from "./script/schema";

/**
 * The runtime contract — which actions each runtime kind allows, and how a
 * WebContainer runtime must be set up — is checked by the script schema and
 * again by the plan schema, both through runtimeContract.ts. Every case below
 * runs through both schemas, so they cannot give different answers without a
 * test failing. Each case lists every issue the schema reports, in order, so a
 * reworded message fails here too.
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
    actions: [run, start, waitForReady, collapseDock, openPreview, expectPreview, expectOutput],
    issues: [
      'Lesson type "go" requires runtime kind "go-playground", got "none"',
      'Action "run" (runtime.run) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "start" (runtime.start) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "wait" (runtime.waitForReady) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "collapse" (runtime.collapseDock) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "open-preview" (preview.open) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "expect-preview" (expect.preview) needs a runnable runtime, but lesson type "go" has none in the studio yet',
      'Action "expect-output" (expect.output) needs a runnable runtime, but lesson type "go" has none in the studio yet',
    ],
  },
  {
    name: "accepts a JavaScript lesson without a lockfile",
    workspace: JS_WORKSPACE,
    runtime: { ...JS_RUNTIME, lockfilePath: undefined },
    actions: [start],
    issues: [],
  },
  {
    // The prepare phase waits for the editor to show the entry file, which
    // never happens, so the render timed out after the narration was paid for.
    name: "rejects an entry file that is not pinned",
    workspace: { ...GO_WORKSPACE, entryFilePath: "absent.go" },
    runtime: GO_RUNTIME,
    actions: [run],
    issues: ['The entry file "absent.go" is not in the pinned workspace'],
  },
  {
    name: "rejects a lockfile that is not pinned",
    workspace: JS_WORKSPACE,
    runtime: { ...JS_RUNTIME, lockfilePath: "pnpm-lock.yaml" },
    actions: [start],
    issues: ['WebContainer lockfile "pnpm-lock.yaml" is not in the pinned workspace'],
  },
  {
    // Every object has a `constructor`, so an `in` lookup counted it as pinned.
    name: "rejects a lockfile named like an Object property",
    workspace: JS_WORKSPACE,
    runtime: { ...JS_RUNTIME, lockfilePath: "constructor" },
    actions: [start],
    issues: ['WebContainer lockfile "constructor" is not in the pinned workspace'],
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

/** The slides and whiteboard assets a case pins beside its workspace. */
interface CasePins {
  slides?: Record<string, unknown>[];
  whiteboardAssets?: Record<string, unknown>[];
}

function scriptIssues(
  workspace: Record<string, unknown>,
  runtime: Record<string, unknown>,
  actions: CaseAction[],
  pins: CasePins = {},
): string[] {
  const result = lessonScriptSchema.safeParse({
    schemaVersion: 1,
    lesson: {
      slug: "runtime-contract",
      title: "Runtime contract",
      locale: "en-US",
      workspace,
      ...pins,
    },
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
  pins: CasePins = {},
): string[] {
  const result = studioPlanSchema.safeParse({
    schemaVersion: 1,
    lesson: { slug: "runtime-contract", title: "Runtime contract", locale: "en-US" },
    seed: 7,
    workspace,
    ...pins,
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

// Membership is an own-key check: an `in` lookup also finds the prototype's
// keys, so a file named `constructor` or `toString` passed as pinned.
describe("pinned file membership", () => {
  it("reports an unpinned file named like an Object property", () => {
    expect(
      pinnedReferenceIssues({ files: { "main.go": "" }, slides: [], whiteboardAssets: [] }, [
        { id: "open", kind: "file", value: "constructor", verb: "opens" },
        { id: "check", kind: "file", value: "main.go", verb: "checks" },
      ]),
    ).toEqual(['Action "open" opens "constructor" which is not in the pinned workspace']);
  });

  it("reports a cursor pointed at an unpinned file named like an Object property", () => {
    const cursor = {
      id: "cursor",
      type: "cursor.moveTo",
      target: { kind: "file", path: "toString" },
      durationMs: 500,
    } as CaseAction;
    expect(planIssues(GO_WORKSPACE, GO_RUNTIME, [run, cursor])).toEqual([
      'Action "cursor" points the cursor at missing file "toString"',
    ]);
  });
});

const slide = (id: string, content: string) => ({ id, contentType: "markdown", content });
const box = (id: string, x: number) => ({
  id,
  kind: "rectangle",
  x,
  y: 100,
  width: 200,
  height: 80,
});

// Every reference resolves with find, so the first definition of a copied id
// always wins and the second slide or shape the narration describes is never
// shown, with nothing reporting it.
describe("duplicatePinnedIdIssues", () => {
  it("reports a repeated slide id and a repeated whiteboard asset id", () => {
    expect(
      duplicatePinnedIdIssues({
        files: {},
        slides: [{ id: "intro" }, { id: "outro" }, { id: "intro" }],
        whiteboardAssets: [{ id: "box" }, { id: "box" }],
      }),
    ).toEqual(['Duplicate slide id "intro"', 'Duplicate whiteboard asset id "box"']);
  });

  it("accepts distinct ids, and a slide and an asset that share one", () => {
    expect(
      duplicatePinnedIdIssues({
        files: {},
        slides: [{ id: "intro" }, { id: "box" }],
        whiteboardAssets: [{ id: "box" }, { id: "arrow" }],
      }),
    ).toEqual([]);
  });
});

describe.each([
  { schema: "script", issuesFor: scriptIssues },
  { schema: "plan", issuesFor: planIssues },
])("$schema schema pinned ids", ({ issuesFor }) => {
  it("rejects a slide or whiteboard asset id defined twice", () => {
    expect(
      issuesFor(GO_WORKSPACE, GO_RUNTIME, [run], {
        slides: [slide("intro", "# One"), slide("intro", "# Two")],
        whiteboardAssets: [box("box", 300), box("box", 600)],
      }),
    ).toEqual(['Duplicate slide id "intro"', 'Duplicate whiteboard asset id "box"']);
  });

  it("accepts distinct slide and whiteboard asset ids", () => {
    expect(
      issuesFor(GO_WORKSPACE, GO_RUNTIME, [run], {
        slides: [slide("intro", "# One"), slide("outro", "# Two")],
        whiteboardAssets: [box("box", 300), box("other-box", 600)],
      }),
    ).toEqual([]);
  });
});
