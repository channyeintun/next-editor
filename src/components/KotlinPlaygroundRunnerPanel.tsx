import { Hexagon } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceErrorKind,
} from "../runtime/kotlinPlayground/client";
import { KOTLIN_CONSOLE_TAG_PATTERN } from "../runtime/kotlinPlayground/console";
import { KOTLIN_PLAYGROUND } from "../runtime/kotlinPlayground/runner";
import type { KotlinPlaygroundRunResult } from "../runtime/kotlinPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Kotlin runner dock: {@link KOTLIN_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const KOTLIN_RUNNER: PlaygroundRunnerLanguage<
  KotlinPlaygroundClient,
  KotlinPlaygroundServiceErrorKind,
  KotlinPlaygroundRunResult
> = {
  ...KOTLIN_PLAYGROUND,
  scrollSurface: "kotlin-runner",
  dockTargetId: runnerDockTargetId("kotlin-runner"),
  runnerTab: { label: "Kotlin Runner", icon: Hexagon },
  consoleTags: { pattern: KOTLIN_CONSOLE_TAG_PATTERN, warningPrefix: "[kotlin-warn" },
};

function KotlinPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={KOTLIN_RUNNER} />;
}

export default KotlinPlaygroundRunnerPanel;
