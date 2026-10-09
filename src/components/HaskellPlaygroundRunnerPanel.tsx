import { SquareFunction } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceErrorKind,
} from "../runtime/haskellPlayground/client";
import { HASKELL_CONSOLE_TAG_PATTERN } from "../runtime/haskellPlayground/console";
import { HASKELL_PLAYGROUND } from "../runtime/haskellPlayground/runner";
import type { HaskellPlaygroundRunResult } from "../runtime/haskellPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Haskell runner dock: {@link HASKELL_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const HASKELL_RUNNER: PlaygroundRunnerLanguage<
  HaskellPlaygroundClient,
  HaskellPlaygroundServiceErrorKind,
  HaskellPlaygroundRunResult
> = {
  ...HASKELL_PLAYGROUND,
  scrollSurface: "haskell-runner",
  dockTargetId: runnerDockTargetId("haskell-runner"),
  runnerTab: { label: "Haskell Runner", icon: SquareFunction },
  // GHC warns far more readily than it errors, so — as in the Kotlin console —
  // the [haskell-warn] tag gets its own color rather than reading as a success
  // line.
  consoleTags: { pattern: HASKELL_CONSOLE_TAG_PATTERN, warningPrefix: "[haskell-warn" },
};

function HaskellPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={HASKELL_RUNNER} />;
}

export default HaskellPlaygroundRunnerPanel;
