import type { WorkspaceStoreInstance } from "../stores/workspaceStore";
import type { WebContainerRuntimeRecordingSnapshot } from "../contexts/WebContainerRuntimeContext";
import type { LivePreviewInspection } from "../stores/previewAdapterHandle";
import type { PreviewScreenshotResult } from "../utils/iframeScreenshotBridge";

/** OpenRouter model slug selected from its live model catalog. */
export type AgentModelId = string;

export const DEFAULT_AGENT_MODEL: AgentModelId = "anthropic/claude-haiku-5.5";

export interface ToolConfirmationRequest {
  toolName: string;
  /** Short human-readable description of what's about to happen, shown in the confirm prompt. */
  summary: string;
}

/** Token totals across every model call a run made. */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What `runtime_diagnostics` reports: the live runtime snapshot's fields plus support. */
export type AgentRuntimeDiagnostics = Pick<
  WebContainerRuntimeRecordingSnapshot,
  | "activeCommand"
  | "errorMessage"
  | "lastOutput"
  | "latestLifecycleEvent"
  | "latestPreviewMessage"
  | "previewPort"
  | "previewUrl"
  | "status"
> & { isSupported: boolean };

/**
 * Injected into each agent tool's `execute` via a closure (see `tools/index.ts`).
 * `workspace` is the same store instance the editor renders from
 * (`stores/workspaceStore.ts`) — tool mutations flow through its `store.trigger.*`
 * events like any other write, which is also how they land in the existing
 * workspace recording track for free.
 */
export interface ToolContext {
  workspace: WorkspaceStoreInstance;
  signal: AbortSignal;
  /** Resolves `true` to proceed. Only the `bash` tool requests it (confirm-gate). */
  requestConfirmation: (request: ToolConfirmationRequest) => Promise<boolean>;
  getRuntimeDiagnostics?: () => AgentRuntimeDiagnostics;
  getPreviewInspection?: () => Promise<LivePreviewInspection | null>;
  capturePreviewScreenshot?: () => Promise<PreviewScreenshotResult>;
}

/**
 * The runtime and preview observation hooks the panel hands a run, carried as
 * one object from Send through the loop to the tools, so a Retry cannot carry a
 * different set than the Send it repeats.
 */
export type AgentObservers = Pick<
  ToolContext,
  "getRuntimeDiagnostics" | "getPreviewInspection" | "capturePreviewScreenshot"
>;

/** Content-array output blocks a tool may return instead of a plain string (e.g. images). */
export type ToolOutputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; imageUrl: string; detail: "auto" | "low" | "high" };

export type CredentialStorage = "memory" | "session" | "local";
