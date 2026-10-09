import { Cog } from "lucide-react";
import PlaygroundRunnerPanel from "./PlaygroundRunnerPanel";
import type { PlaygroundRunnerLanguage } from "./playgroundRunnerLanguage";
import type {
  RustPlaygroundClient,
  RustPlaygroundServiceErrorKind,
} from "../runtime/rustPlayground/client";
import { RUST_CONSOLE_TAG_PATTERN } from "../runtime/rustPlayground/console";
import { RUST_PLAYGROUND } from "../runtime/rustPlayground/runner";
import type { RustPlaygroundRunResult } from "../runtime/rustPlayground/types";
import { runnerDockTargetId } from "../studio/targets";

/** The Rust runner dock: {@link RUST_PLAYGROUND} in the shared PlaygroundRunnerPanel. */
export const RUST_RUNNER: PlaygroundRunnerLanguage<
  RustPlaygroundClient,
  RustPlaygroundServiceErrorKind,
  RustPlaygroundRunResult
> = {
  ...RUST_PLAYGROUND,
  scrollSurface: "rust-runner",
  dockTargetId: runnerDockTargetId("rust-runner"),
  runnerTab: { label: "Rust Runner", icon: Cog },
  consoleTags: { pattern: RUST_CONSOLE_TAG_PATTERN },
};

function RustPlaygroundRunnerPanel() {
  return <PlaygroundRunnerPanel language={RUST_RUNNER} />;
}

export default RustPlaygroundRunnerPanel;
