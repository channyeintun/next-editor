// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import type { LoggerEvent } from "babel-plugin-react-compiler";
import { describe, expect, it } from "vitest";

/**
 * The React Compiler is this app's memoization: manual useMemo/useCallback were
 * removed and react-hooks/exhaustive-deps is off (see vite.config.ts). It skips,
 * silently, any component or hook it cannot compile, and Vitest does not run it,
 * so no render test notices when a provider's context value goes back to being a
 * new object on every render. This runs the same plugin, with the options
 * vite.config.ts's reactCompilerPreset() passes (none), over the context
 * providers and fails on every function it would skip.
 */
const PROVIDER_FILES = [
  "src/contexts/ApiClientStoreContext.tsx",
  "src/contexts/CaptionStoreContext.tsx",
  "src/contexts/NextEditorProvider.tsx",
  "src/contexts/PreviewAdapterHandleContext.tsx",
  "src/contexts/PreviewPanelContext.tsx",
  "src/contexts/RuntimePanelStoreContext.tsx",
  "src/contexts/SlidesContext.tsx",
  "src/contexts/SlidesStoreContext.tsx",
  "src/contexts/WhiteboardContext.tsx",
  "src/contexts/WhiteboardStoreContext.tsx",
  "src/contexts/WorkspaceProvider.tsx",
];

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

function compile(path: string) {
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
  return {
    failures: events.map(describeFailure).filter((failure) => failure !== null),
    compiled: events.filter((event) => event.kind === "CompileSuccess").length,
  };
}

describe("React Compiler coverage of the context providers", () => {
  it.each(PROVIDER_FILES)("compiles every component and hook in %s", (path) => {
    const { failures, compiled } = compile(path);
    expect(failures).toEqual([]);
    expect(compiled).toBeGreaterThan(0);
  });
});
