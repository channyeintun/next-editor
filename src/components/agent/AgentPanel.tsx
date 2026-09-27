import { useContext, useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, Plus, Send, Settings, Square } from "lucide-react";
import { WorkspaceStoreContext } from "../../stores/workspaceStore";
import {
  getAgentStore,
  selectDraft,
  selectDraftImages,
  selectError,
  selectItems,
  selectModel,
  selectReplaySnapshot,
  selectStatus,
} from "../../agent/agentStore";
import { getAgentCredentialStore, selectApiKey } from "../../agent/credentials";
import {
  getAgentSessionStore,
  clearAgentRetry,
  retryAgentRun,
  resolveConfirmation,
  selectCanRetry,
  selectIsRunning,
  selectPending,
  startAgentRun,
  stopAgentRun,
  synchronizeAgentWorkspace,
} from "../../agent/agentSession";
import type { ChatItem, ChatStatus } from "../../types/chat";
import {
  createChatImage,
  getClipboardImageFiles,
  MAX_CHAT_IMAGES,
} from "../../agent/imageAttachments";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useWorkspaceLoadVersion } from "../../hooks/useWorkspace";
import { usePreviewAdapterHandle } from "../../contexts/PreviewAdapterHandleContext";
import {
  useWebContainerRuntimeMetadata,
  useWebContainerRuntimeSnapshotGetter,
} from "../../hooks/useWebContainerRuntime";
import { createChatCheckpoint } from "../../agent/chatRecording";
import AgentErrorNotice from "./AgentErrorNotice";
import AgentSettingsDialog from "./AgentSettingsDialog";
import DraftImageStrip from "./DraftImageStrip";
import ToolConfirmationCard from "./ToolConfirmationCard";
import { formatToolResultOutput } from "./toolResultOutput";
import { useOpenRouterModelCatalog } from "./useOpenRouterModelCatalog";

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "Idle",
  streaming: "Streaming…",
  "running-tool": "Running tool…",
  "waiting-confirmation": "Waiting for confirmation…",
  done: "Done",
  error: "Error",
};

function summarizeToolArguments(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
    const candidate = parsed.path ?? parsed.command ?? parsed.pattern;
    return typeof candidate === "string" ? candidate : "";
  } catch {
    return "";
  }
}

function ToolCallChip({ item }: { item: Extract<ChatItem, { kind: "tool_call" }> }) {
  const summary = summarizeToolArguments(item.arguments);

  return (
    <div className="ml-4 inline-flex max-w-full items-center gap-1.5 rounded-md bg-[#1e2129] px-2.5 py-1 font-mono text-[11px] text-slate-400">
      <span className="text-[#64a3ff]">{item.name}</span>
      {summary ? <span className="truncate text-slate-500">{summary}</span> : null}
    </div>
  );
}

function ToolResultRow({ item }: { item: Extract<ChatItem, { kind: "tool_result" }> }) {
  const [expanded, setExpanded] = useState(false);
  const text = formatToolResultOutput(item.output);
  const isLong = text.length > 300;
  const shown = expanded || !isLong ? text : `${text.slice(0, 300)}…`;

  if (!text) {
    return null;
  }

  return (
    <div
      className={`ml-4 rounded-md border px-3 py-2 font-mono text-xs ${
        item.isError
          ? "border-red-900 bg-red-950/40 text-red-300"
          : "border-slate-800 bg-[#171b22] text-slate-400"
      }`}
    >
      <pre className="whitespace-pre-wrap wrap-break-word">{shown}</pre>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] font-semibold text-slate-500 hover:text-slate-300"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

function MessageRow({ item }: { item: Extract<ChatItem, { kind: "message" }> }) {
  if (!item.text && !item.images?.length) {
    return null;
  }

  return (
    <div className={item.role === "user" ? "flex justify-end" : ""}>
      <div className={item.role === "user" ? "max-w-[85%]" : "w-full"}>
        <div
          className={`rounded-md px-3 py-2 text-[13px] leading-6 ${
            item.role === "user" ? "bg-[#233047] text-slate-100" : "bg-transparent text-slate-200"
          }`}
        >
          {item.images?.length ? (
            <div className={`mb-2 grid gap-2 ${item.images.length > 1 ? "grid-cols-2" : ""}`}>
              {item.images.map((image) => (
                <img
                  key={image.id}
                  src={image.dataUrl}
                  alt={image.name ?? "Pasted image"}
                  className="max-h-56 w-full rounded border border-slate-700 object-contain"
                />
              ))}
            </div>
          ) : null}
          {item.text ? (
            <div className="whitespace-pre-wrap wrap-break-word">{item.text}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TranscriptItem({ item }: { item: ChatItem }) {
  if (item.kind === "message") {
    return <MessageRow item={item} />;
  }
  if (item.kind === "tool_call") {
    return <ToolCallChip item={item} />;
  }
  return <ToolResultRow item={item} />;
}

function AgentPanel({ isFullHeight = false }: { isFullHeight?: boolean }) {
  const workspaceStore = useContext(WorkspaceStoreContext);
  const agentStore = getAgentStore();
  const credentialStore = getAgentCredentialStore();
  const sessionStore = getAgentSessionStore();
  const { handleChatEvent } = useNextEditorActions();
  const { isPlaying, isRecording } = useNextEditorMetadata();
  const previewHandle = usePreviewAdapterHandle();
  const runtimeMetadata = useWebContainerRuntimeMetadata();
  const getRuntimeSnapshot = useWebContainerRuntimeSnapshotGetter();
  const workspaceLoadVersion = useWorkspaceLoadVersion();

  const liveItems = useSelector(agentStore, (s) => selectItems(s.context));
  const liveStatus = useSelector(agentStore, (s) => selectStatus(s.context));
  const liveDraft = useSelector(agentStore, (s) => selectDraft(s.context));
  const liveDraftImages = useSelector(agentStore, (s) => selectDraftImages(s.context));
  const replaySnapshot = useSelector(agentStore, (s) => selectReplaySnapshot(s.context));
  const error = useSelector(agentStore, (s) => selectError(s.context));
  const model = useSelector(agentStore, (s) => selectModel(s.context));
  const apiKey = useSelector(credentialStore, (s) => selectApiKey(s.context));
  // Run state lives in the session singleton (not this component), so it survives the
  // dock tab switches / collapses that mount and unmount this panel — see agentSession.ts.
  const isRunning = useSelector(sessionStore, (s) => selectIsRunning(s.context));
  const pending = useSelector(sessionStore, (s) => selectPending(s.context));
  const canRetry = useSelector(sessionStore, (s) => selectCanRetry(s.context));

  // While replaying a recording (and not live-recording over it), render the folded
  // chat track instead of the live agent store. A recording with no agent activity
  // shows an empty panel (fall back to `[]`, not the live conversation).
  const isReplayActive = isPlaying && !isRecording;
  const items = isReplayActive ? (replaySnapshot?.items ?? []) : liveItems;
  const status = isReplayActive ? (replaySnapshot?.status ?? "idle") : liveStatus;
  const promptInput = isReplayActive ? (replaySnapshot?.draft ?? "") : liveDraft;
  const promptImages = isReplayActive ? [] : liveDraftImages;

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const wasRecordingRef = useRef(false);
  const runtimeMetadataRef = useRef(runtimeMetadata);

  useEffect(() => {
    if (!workspaceStore || isReplayActive) {
      return;
    }

    if (synchronizeAgentWorkspace(workspaceStore)) {
      handleChatEvent({ k: "reset" });
    }
  }, [handleChatEvent, isReplayActive, workspaceLoadVersion, workspaceStore]);

  // Seed recording with the complete conversation that is already visible.
  // Subsequent changes are captured as deltas.
  useEffect(() => {
    if (isRecording && !wasRecordingRef.current) {
      handleChatEvent({ k: "checkpoint", state: createChatCheckpoint(agentStore) });
    }
    wasRecordingRef.current = isRecording;
  }, [agentStore, handleChatEvent, isRecording]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  useEffect(() => {
    runtimeMetadataRef.current = runtimeMetadata;
  }, [runtimeMetadata]);

  // Called after the effects above so its fetch effect keeps its place in their order.
  const modelCatalog = useOpenRouterModelCatalog(isSettingsOpen);

  // Reflects the actual live run (for Send/Stop + input disable); the status label/
  // spinner below tracks the displayed status, which during replay is the recorded one.
  const isBusy = isRunning;
  const isActiveStatus =
    status === "streaming" || status === "running-tool" || status === "waiting-confirmation";
  const activeConfirmation = pending[0] ?? null;
  const selectedModelOption = modelCatalog.modelOptions.find((option) => option.id === model);
  const selectedModelLabel = selectedModelOption?.label ?? model;

  const applyDraft = (text: string) => {
    const delta = { k: "draft", text } as const;
    agentStore.trigger.applyDelta({ delta });
    handleChatEvent(delta);
  };

  const handleSubmit = () => {
    const prompt = promptInput.trim();

    if (
      (!prompt && promptImages.length === 0) ||
      isBusy ||
      !apiKey ||
      !workspaceStore ||
      isReplayActive
    ) {
      return;
    }

    const images = promptImages;
    applyDraft("");
    agentStore.trigger.clearDraftImages();
    setAttachmentError(null);
    void startAgentRun({
      apiKey,
      model,
      workspace: workspaceStore,
      prompt,
      images,
      handleChatEvent,
      getRuntimeDiagnostics: () => {
        const metadata = runtimeMetadataRef.current;
        const snapshot = getRuntimeSnapshot();
        return {
          activeCommand: snapshot.activeCommand,
          errorMessage: snapshot.errorMessage,
          isSupported: metadata.isSupported,
          lastOutput: snapshot.lastOutput,
          latestLifecycleEvent: snapshot.latestLifecycleEvent,
          latestPreviewMessage: snapshot.latestPreviewMessage,
          previewPort: snapshot.previewPort,
          previewUrl: snapshot.previewUrl,
          status: snapshot.status,
        };
      },
      getPreviewInspection: async () =>
        (await previewHandle.livePreviewInspectionGetter.current?.()) ?? null,
      capturePreviewScreenshot: async () => {
        if (!selectedModelOption?.supportsImages) {
          throw new Error(
            `${selectedModelLabel} does not advertise image input support on OpenRouter. Use inspect_preview instead.`,
          );
        }
        const capture = previewHandle.previewScreenshotCapturer.current;
        if (!capture) {
          throw new Error("The live preview is not mounted.");
        }
        return capture();
      },
    });
  };

  const handleStop = () => {
    stopAgentRun();
  };

  const handleRetry = () => {
    if (isBusy || !canRetry || !apiKey || !workspaceStore || isReplayActive) {
      return;
    }
    void retryAgentRun({ apiKey, model, workspace: workspaceStore });
  };

  const handleNewChat = () => {
    if (isBusy || isReplayActive) {
      return;
    }
    agentStore.trigger.reset();
    handleChatEvent({ k: "reset" });
    clearAgentRetry();
    setAttachmentError(null);
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = getClipboardImageFiles(event.clipboardData);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    const availableSlots = MAX_CHAT_IMAGES - agentStore.getSnapshot().context.draftImages.length;
    if (availableSlots <= 0) {
      setAttachmentError(`You can attach up to ${MAX_CHAT_IMAGES} images.`);
      return;
    }
    // Worked out before the try: the React Compiler skips a whole component
    // that has a conditional inside a try block.
    const truncationNotice =
      files.length > availableSlots
        ? `Only the first ${availableSlots} images were attached.`
        : null;

    try {
      const images = await Promise.all(files.slice(0, availableSlots).map(createChatImage));
      const latestSlots = MAX_CHAT_IMAGES - agentStore.getSnapshot().context.draftImages.length;
      agentStore.trigger.addDraftImages({ images: images.slice(0, latestSlots) });
      setAttachmentError(truncationNotice);
    } catch (pasteError) {
      setAttachmentError(pasteError instanceof Error ? pasteError.message : String(pasteError));
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <div
        className={`flex ${isFullHeight ? "min-h-0 flex-1" : "h-72"} flex-col bg-[#15191f]`}
        data-cursor-replay-target="agent-panel"
      >
        <div className="flex min-h-11 items-center gap-2 border-b border-[#11151d] bg-[#191d25] px-4 py-2.5">
          <Bot size={14} className="text-[#64a3ff]" />
          <span className="truncate text-[11px] font-semibold text-slate-400">
            {STATUS_LABEL[status]}
          </span>
          {isActiveStatus ? (
            <span
              aria-label="Agent is working"
              className="inline-block size-2.5 shrink-0 animate-spin rounded-full border-2 border-[#64a3ff] border-t-transparent"
            />
          ) : null}
          <button
            type="button"
            onClick={handleNewChat}
            disabled={isBusy || isReplayActive}
            className="ml-auto inline-flex size-8 items-center justify-center text-slate-500 transition-colors hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="New chat"
            title="New chat"
          >
            <Plus size={16} />
          </button>
          <button
            data-tour="agent-settings"
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="inline-flex size-8 items-center justify-center text-slate-500 transition-colors hover:text-slate-200"
            aria-label="Open agent settings"
            title="Agent settings"
          >
            <Settings size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {items.length === 0 ? (
              <p className="px-1 text-xs text-slate-500">
                Ask the agent to build or fix something in this workspace.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {items.map((item) => (
                  <TranscriptItem key={item.id} item={item} />
                ))}
              </div>
            )}
            {error && !isReplayActive ? (
              <AgentErrorNotice
                error={error}
                canRetry={canRetry}
                isRetryDisabled={isBusy || !apiKey}
                onRetry={handleRetry}
              />
            ) : null}
            <div ref={transcriptEndRef} />
          </div>

          {activeConfirmation ? (
            <ToolConfirmationCard
              request={activeConfirmation.request}
              onResolve={(approved) => resolveConfirmation(activeConfirmation.id, approved)}
            />
          ) : null}

          <div className="border-t border-[#11151d] bg-[#13171e] p-3">
            <div className="rounded-lg border border-slate-700/80 bg-[#0f1319] shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-colors focus-within:border-[#64a3ff]/70 focus-within:ring-1 focus-within:ring-[#64a3ff]/25">
              <DraftImageStrip
                images={promptImages}
                onRemove={(id) => agentStore.trigger.removeDraftImage({ id })}
              />
              <textarea
                value={promptInput}
                onChange={(event) => applyDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                disabled={isBusy || isReplayActive}
                aria-label="Message the agent"
                placeholder="Ask anything about this workspace"
                rows={2}
                className="h-14 min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {attachmentError ? (
                <p className="px-3 pb-2 text-[11px] text-amber-400">{attachmentError}</p>
              ) : null}
              <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  disabled={isReplayActive}
                  className="max-w-[calc(100%-3rem)] truncate rounded px-1.5 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Choose agent model"
                >
                  {selectedModelLabel}
                </button>
                {isBusy && !isReplayActive ? (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded bg-red-900/80 text-red-200 transition-colors hover:bg-red-800"
                    aria-label="Stop agent"
                    title="Stop agent"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={
                      (!promptInput.trim() && promptImages.length === 0) ||
                      !apiKey ||
                      isReplayActive
                    }
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded bg-[#58d88d] text-[#0b2416] transition-colors hover:bg-[#7ce5a5] disabled:cursor-not-allowed disabled:bg-[#27382f] disabled:text-slate-500"
                    aria-label="Send message"
                    title="Send message"
                  >
                    <Send size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isSettingsOpen ? (
        <AgentSettingsDialog
          modelCatalog={modelCatalog}
          modelQuery={modelQuery}
          onModelQueryChange={setModelQuery}
          keyDraft={keyDraft}
          onKeyDraftChange={setKeyDraft}
          onClose={() => setIsSettingsOpen(false)}
        />
      ) : null}
    </>
  );
}

export default AgentPanel;
