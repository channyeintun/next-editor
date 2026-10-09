import { Cpu } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  AsmPlaygroundClient,
  AsmPlaygroundServiceErrorKind,
} from "../runtime/asmPlayground/client";
import { ASM_CONSOLE_TAG_PATTERN } from "../runtime/asmPlayground/console";
import { ASM_PLAYGROUND } from "../runtime/asmPlayground/runner";
import type { AsmPlaygroundRunResult } from "../runtime/asmPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/**
 * The assembly runner dock: {@link ASM_PLAYGROUND} in the shared
 * PlaygroundRunnerPanel.
 *
 * CodeEditor loads this module lazily, so `src/core/x86` is fetched only for an
 * assembly lesson.
 */
export const ASM_RUNNER: PlaygroundRunnerLanguage<
  AsmPlaygroundClient,
  AsmPlaygroundServiceErrorKind,
  AsmPlaygroundRunResult
> = {
  ...ASM_PLAYGROUND,
  scrollSurface: "asm-runner",
  dockTargetId: runnerDockTargetId("asm-runner"),
  runnerTab: { label: "Assembly Runner", icon: Cpu },
  consoleTags: { pattern: ASM_CONSOLE_TAG_PATTERN },
};

function AsmPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={ASM_RUNNER} />;
}

export default AsmPlaygroundRunnerPanel;
