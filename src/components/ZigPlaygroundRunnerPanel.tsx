import { Cog } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  ZigPlaygroundClient,
  ZigPlaygroundServiceErrorKind,
} from "../runtime/zigPlayground/client";
import { ZIG_CONSOLE_TAG_PATTERN } from "../runtime/zigPlayground/console";
import { ZIG_PLAYGROUND } from "../runtime/zigPlayground/runner";
import type { ZigPlaygroundRunResult } from "../runtime/zigPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Zig runner dock: {@link ZIG_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const ZIG_RUNNER: PlaygroundRunnerLanguage<
  ZigPlaygroundClient,
  ZigPlaygroundServiceErrorKind,
  ZigPlaygroundRunResult
> = {
  ...ZIG_PLAYGROUND,
  scrollSurface: "zig-runner",
  dockTargetId: runnerDockTargetId("zig-runner"),
  runnerTab: { label: "Zig Runner", icon: Cog },
  consoleTags: { pattern: ZIG_CONSOLE_TAG_PATTERN },
};

function ZigPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={ZIG_RUNNER} />;
}

export default ZigPlaygroundRunnerPanel;
