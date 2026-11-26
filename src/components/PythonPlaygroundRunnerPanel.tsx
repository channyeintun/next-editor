import { SquareTerminal } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  PythonPlaygroundClient,
  PythonPlaygroundServiceErrorKind,
} from "../runtime/pythonPlayground/client";
import { PYTHON_CONSOLE_TAG_PATTERN } from "../runtime/pythonPlayground/console";
import { PYTHON_PLAYGROUND } from "../runtime/pythonPlayground/runner";
import type { PythonPlaygroundRunResult } from "../runtime/pythonPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Python runner dock: {@link PYTHON_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const PYTHON_RUNNER: PlaygroundRunnerLanguage<
  PythonPlaygroundClient,
  PythonPlaygroundServiceErrorKind,
  PythonPlaygroundRunResult
> = {
  ...PYTHON_PLAYGROUND,
  scrollSurface: "python-runner",
  dockTargetId: runnerDockTargetId("python-runner"),
  runnerTab: { label: "Python Runner", icon: SquareTerminal },
  consoleTags: { pattern: PYTHON_CONSOLE_TAG_PATTERN },
};

function PythonPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={PYTHON_RUNNER} />;
}

export default PythonPlaygroundRunnerPanel;
