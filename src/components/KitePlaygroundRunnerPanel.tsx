import { Cog } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  KitePlaygroundClient,
  KitePlaygroundServiceErrorKind,
} from "../runtime/kitePlayground/client";
import { KITE_CONSOLE_TAG_PATTERN } from "../runtime/kitePlayground/console";
import { KITE_PLAYGROUND } from "../runtime/kitePlayground/runner";
import type { KitePlaygroundRunResult } from "../runtime/kitePlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Kite runner dock: {@link KITE_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const KITE_RUNNER: PlaygroundRunnerLanguage<
  KitePlaygroundClient,
  KitePlaygroundServiceErrorKind,
  KitePlaygroundRunResult
> = {
  ...KITE_PLAYGROUND,
  scrollSurface: "kite-runner",
  dockTargetId: runnerDockTargetId("kite-runner"),
  runnerTab: { label: "Kite Runner", icon: Cog },
  consoleTags: { pattern: KITE_CONSOLE_TAG_PATTERN },
};

function KitePlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={KITE_RUNNER} />;
}

export default KitePlaygroundRunnerPanel;
