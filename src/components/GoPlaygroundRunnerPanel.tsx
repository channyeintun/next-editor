import { Diamond } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  GoPlaygroundClient,
  GoPlaygroundServiceErrorKind,
} from "../runtime/goPlayground/client";
import { GO_CONSOLE_TAG_PATTERN } from "../runtime/goPlayground/console";
import { GO_PLAYGROUND } from "../runtime/goPlayground/runner";
import type { GoPlaygroundRunResult } from "../runtime/goPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Go runner dock: {@link GO_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const GO_RUNNER: PlaygroundRunnerLanguage<
  GoPlaygroundClient,
  GoPlaygroundServiceErrorKind,
  GoPlaygroundRunResult
> = {
  ...GO_PLAYGROUND,
  scrollSurface: "go-runner",
  dockTargetId: runnerDockTargetId("go-runner"),
  runnerTab: { label: "Go Runner", icon: Diamond },
  consoleTags: { pattern: GO_CONSOLE_TAG_PATTERN, warningPrefix: "[go-vet" },
};

function GoPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={GO_RUNNER} />;
}

export default GoPlaygroundRunnerPanel;
