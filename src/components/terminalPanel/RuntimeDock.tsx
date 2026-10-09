import { lazy, Suspense, type ComponentType } from "react";
import type { WorkspaceLessonType } from "../../types/workspace";
import { executionKindForLessonType, type WorkspaceExecutionKind } from "../../types/lessonTypes";
import GoPlaygroundRunnerPanel from "../GoPlaygroundRunnerPanel";
import HaskellPlaygroundRunnerPanel from "../HaskellPlaygroundRunnerPanel";
import KitePlaygroundRunnerPanel from "../KitePlaygroundRunnerPanel";
import KotlinPlaygroundRunnerPanel from "../KotlinPlaygroundRunnerPanel";
import RustPlaygroundRunnerPanel from "../RustPlaygroundRunnerPanel";
import TerminalPanel from "../TerminalPanel";
import ZigPlaygroundRunnerPanel from "../ZigPlaygroundRunnerPanel";

// The other runner panels are thin clients in front of a Worker proxy, but this
// one reaches the whole first-party x86-64 assembler and CPU in `src/core/x86`,
// which only an `asm` lesson can ever run. Splitting it out keeps that code from
// being fetched and parsed on every editor load, the way CodeEditor's `Preview`
// already is.
const AsmPlaygroundRunnerPanel = lazy(() => import("../AsmPlaygroundRunnerPanel"));

// One entry per non-webcontainer execution kind. The `Record` is what makes a new
// playground kind a compile error here rather than a lesson that renders an editor
// with no dock at all — no Run button, no console, and nothing to point at.
const RUNNER_PANELS: Record<Exclude<WorkspaceExecutionKind, "webcontainer">, ComponentType> = {
  "go-playground": GoPlaygroundRunnerPanel,
  "kotlin-playground": KotlinPlaygroundRunnerPanel,
  "rust-playground": RustPlaygroundRunnerPanel,
  "zig-playground": ZigPlaygroundRunnerPanel,
  "haskell-playground": HaskellPlaygroundRunnerPanel,
  "kite-playground": KitePlaygroundRunnerPanel,
  "asm-playground": AsmPlaygroundRunnerPanel,
};

/**
 * The dock under the editor that runs the lesson: the terminal for a lesson
 * that runs in the WebContainer, its playground's runner panel otherwise.
 */
export default function RuntimeDock({ lessonType }: { lessonType: WorkspaceLessonType }) {
  const executionKind = executionKindForLessonType(lessonType);
  if (executionKind === "webcontainer") return <TerminalPanel />;
  const RunnerPanel = RUNNER_PANELS[executionKind];
  return (
    // Only the asm panel is lazy; the rest resolve synchronously and
    // never suspend, so this Suspense is inert for them.
    <Suspense fallback={null}>
      <RunnerPanel />
    </Suspense>
  );
}
