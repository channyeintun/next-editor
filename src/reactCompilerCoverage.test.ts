// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { describe, expect, it } from "vite-plus/test";

/**
 * The React Compiler is this app's memoization: manual useMemo/useCallback were
 * removed and react-hooks/exhaustive-deps is off (see vite.config.ts). It skips,
 * silently, any component or hook it cannot compile, and a skipped function still
 * renders correctly, so no render test notices when a context value or an effect
 * dependency goes back to being new on every render. This runs the same plugin,
 * with the options vite.config.ts's reactCompilerPreset() passes (none), over
 * every module that defines a component or a hook, and fails on each function it
 * would skip — unless the module is listed in NOT_COMPILED with the reason it
 * stays uncompiled. A listed module that compiles cleanly fails as well, so the
 * list can only shrink.
 */
const SOURCE_ROOTS = ["src", "tube/src", "infra/client"];

const NOT_COMPILED: Record<string, string> = {
  "src/components/CodeEditor.tsx":
    'opts out with "use no memo": Monaco models are reconciled during render, and the ' +
    "compiler's memoization once broke syntax highlighting",
  "src/components/codeEditor/useYMonacoBinding.ts":
    'opts out with "use no memo", like the CodeEditor it was extracted from, so its ' +
    "effects keep their timing; setting up the binding also needs a try/finally",
  "src/contexts/CollaborationContext.tsx":
    "try/finally, and refs written during render; its useCallback/useMemo are load-bearing " +
    "(the room effect that owns the WebSocket depends on them)",
  "src/contexts/collaboration/useCollaborationInvitation.ts":
    "try/finally in acceptInvitation; keeps the provider's explicit useCallbacks",
  "src/contexts/collaboration/useCollaborativeWorkspaceActions.ts":
    "writes canWriteRef during render; keeps the provider's explicit useMemos",
  "src/components/CollaborationPanel.tsx":
    "try/finally; compiled, it would also freeze getPathForNodeId, which reads a ref " +
    "the provider replaces on every document change",
  "src/components/preview/usePreviewController.ts":
    "writes the preview handle's refs, which a hook returned (since e08258ec); compiling " +
    "it changes when the preview's effects re-run, so it needs a replay check in Chrome",
  "src/components/preview/usePreviewPlaybackRegistration.ts":
    "writes the preview handle's refs, which a hook returned",
  "src/components/preview/usePreviewInteractionCapture.ts":
    "conditional expressions inside a try block",
  "src/hooks/useUrlLoader.ts": "try/finally, and a throw inside a try block",
  "src/studio/StudioController.tsx": "try/finally, and throws inside try blocks",
  "src/components/RecordingDraftRecovery.tsx": "try/finally",
  "src/components/LandingPage.tsx": "reads refs during render",
  "infra/client/upload/UploadCaptionsField.tsx": "an await import() inside the component",
};

// A module defines a component or a hook when it is .tsx or declares a use* function.
const DEFINES_REACT_CODE = /(?:function|const)\s+use[A-Z]/;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listSourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const REACT_FILES = SOURCE_ROOTS.flatMap((root) => listSourceFiles(resolve(root)))
  .filter((path) => path.endsWith(".tsx") || DEFINES_REACT_CODE.test(readFileSync(path, "utf8")))
  .map((path) => relative(process.cwd(), path))
  .sort();

// @babel/core ships no type declarations; this is the one call the test makes.
const require = createRequire(import.meta.url);
const babel = require("@babel/core") as {
  transformSync: (code: string, options: Record<string, unknown>) => unknown;
};
const reactCompilerPlugin = require.resolve("babel-plugin-react-compiler");

function describeFailure(event: LoggerEvent): string | null {
  if (event.kind !== "CompileError" && event.kind !== "PipelineError") return null;
  const line = event.fnLoc?.start.line ?? "?";
  const reason =
    event.kind === "PipelineError"
      ? String(event.data)
      : "reason" in event.detail
        ? event.detail.reason
        : String(event.detail);
  return `function at line ${line}: ${reason}`;
}

function compileFailures(path: string): string[] {
  const events: LoggerEvent[] = [];
  babel.transformSync(readFileSync(resolve(path), "utf8"), {
    filename: path,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["typescript", "jsx"] },
    plugins: [
      [
        reactCompilerPlugin,
        {
          logger: {
            logEvent: (_filename: string | null, event: LoggerEvent) => events.push(event),
          },
        },
      ],
    ],
  });
  return events.map(describeFailure).filter((failure) => failure !== null);
}

describe("React Compiler coverage", () => {
  it("lists only modules that exist", () => {
    expect(Object.keys(NOT_COMPILED).filter((path) => !REACT_FILES.includes(path))).toEqual([]);
  });

  it.each(REACT_FILES.filter((path) => !(path in NOT_COMPILED)))(
    "compiles every component and hook in %s",
    (path) => {
      expect(compileFailures(path)).toEqual([]);
    },
  );

  // Once a listed module compiles, take it off NOT_COMPILED so it cannot fall back unnoticed.
  it.each(Object.keys(NOT_COMPILED))("still has a reason to list %s", (path) => {
    expect(compileFailures(path), `${path} compiles; remove it from NOT_COMPILED`).not.toEqual([]);
  });
});
