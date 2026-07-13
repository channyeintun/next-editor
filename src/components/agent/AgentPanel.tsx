import { useContext, useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import {
  AlertTriangle,
  Bot,
  Check,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
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
  selectUsage,
} from "../../agent/agentStore";
import {
  getAgentCredentialStore,
  selectApiKey,
  selectCredentialStorage,
} from "../../agent/credentials";
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
} from "../../agent/agentSession";
import type { CredentialStorage } from "../../agent/types";
import type { ChatItem, ChatStatus } from "../../types/chat";
import {
  createChatImage,
  getClipboardImageFiles,
  MAX_CHAT_IMAGES,
} from "../../agent/imageAttachments";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { usePreviewAdapterHandle } from "../../contexts/PreviewAdapterHandleContext";
import {
  useWebContainerRuntimeMetadata,
  useWebContainerRuntimeSnapshotGetter,
} from "../../hooks/useWebContainerRuntime";
import {
  FALLBACK_MODEL_OPTIONS,
  fetchOpenRouterModelOptions,
  filterModelOptions,
} from "../../agent/modelCatalog";
import { formatToolResultOutput } from "./toolResultOutput";

const STORAGE_OPTIONS: { id: CredentialStorage; label: string; description: string }[] = [
  { id: "memory", label: "Memory only", description: "Cleared on reload. Safest." },
  {
    id: "session",
    label: "This tab",
    description: "Survives reload, cleared when the tab closes.",
  },
  { id: "local", label: "This device", description: "Persists across sessions on this browser." },
];

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
          {item.text ? <div className="whitespace-pre-wrap wrap-break-word">{item.text}</div> : null}
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

  const liveItems = useSelector(agentStore, (s) => selectItems(s.context));
  const liveStatus = useSelector(agentStore, (s) => selectStatus(s.context));
  const liveDraft = useSelector(agentStore, (s) => selectDraft(s.context));
  const liveDraftImages = useSelector(agentStore, (s) => selectDraftImages(s.context));
  const replaySnapshot = useSelector(agentStore, (s) => selectReplaySnapshot(s.context));
  const error = useSelector(agentStore, (s) => selectError(s.context));
  const usage = useSelector(agentStore, (s) => selectUsage(s.context));
  const model = useSelector(agentStore, (s) => selectModel(s.context));
  const apiKey = useSelector(credentialStore, (s) => selectApiKey(s.context));
  const credentialStorage = useSelector(credentialStore, (s) => selectCredentialStorage(s.context));
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
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
  const [modelQuery, setModelQuery] = useState("");
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const wasRecordingRef = useRef(false);
  const hasLoadedModelCatalogRef = useRef(false);
  const runtimeMetadataRef = useRef(runtimeMetadata);

  // Seed the track with a draft that was already present when recording began.
  // Subsequent edits are captured directly by `applyDraft` below.
  useEffect(() => {
    if (isRecording && !wasRecordingRef.current) {
      handleChatEvent({ k: "draft", text: agentStore.getSnapshot().context.draft });
    }
    wasRecordingRef.current = isRecording;
  }, [agentStore, handleChatEvent, isRecording]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [items]);

  useEffect(() => {
    runtimeMetadataRef.current = runtimeMetadata;
  }, [runtimeMetadata]);

  useEffect(() => {
    if (!isSettingsOpen || hasLoadedModelCatalogRef.current) {
      return;
    }

    const controller = new AbortController();
    setIsModelCatalogLoading(true);
    setModelCatalogError(null);

    void fetchOpenRouterModelOptions(controller.signal)
      .then((options) => {
        if (options.length > 0) {
          setModelOptions(options);
          hasLoadedModelCatalogRef.current = true;
        } else {
          setModelCatalogError("OpenRouter returned no models; showing fallbacks.");
        }
      })
      .catch((catalogError: unknown) => {
        if (!controller.signal.aborted) {
          setModelCatalogError(
            catalogError instanceof Error
              ? `${catalogError.message}; showing fallback models.`
              : "Could not load OpenRouter models; showing fallbacks.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsModelCatalogLoading(false);
        }
      });

    return () => controller.abort();
  }, [isSettingsOpen]);

  // Reflects the actual live run (for Send/Stop + input disable); the status label/
  // spinner below tracks the displayed status, which during replay is the recorded one.
  const isBusy = isRunning;
  const isActiveStatus =
    status === "streaming" || status === "running-tool" || status === "waiting-confirmation";
  const activeConfirmation = pending[0] ?? null;
  const filteredModelOptions = filterModelOptions(modelOptions, modelQuery);
  const selectedModelOption = modelOptions.find((option) => option.id === model);
  const selectedModelLabel = selectedModelOption?.label ?? model;

  const applyDraft = (text: string) => {
    const delta = { k: "draft", text } as const;
    agentStore.trigger.applyDelta({ delta });
    handleChatEvent(delta);
  };

  const handleSubmit = () => {
    const prompt = promptInput.trim();

    if ((!prompt && promptImages.length === 0) || isBusy || !apiKey || !workspaceStore || isReplayActive) {
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
      getPreviewInspection: () =>
        previewHandle.livePreviewInspectionGetter.current?.() ?? null,
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
    if (isBusy || !canRetry || !apiKey || isReplayActive) {
      return;
    }
    void retryAgentRun({ apiKey, model });
  };

  const handleNewChat = () => {
    if (isBusy || isReplayActive) {
      return;
    }
    agentStore.trigger.reset();
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

    try {
      const images = await Promise.all(files.slice(0, availableSlots).map(createChatImage));
      const latestSlots = MAX_CHAT_IMAGES - agentStore.getSnapshot().context.draftImages.length;
      agentStore.trigger.addDraftImages({ images: images.slice(0, latestSlots) });
      setAttachmentError(
        files.length > availableSlots ? `Only the first ${availableSlots} images were attached.` : null,
      );
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

  const handleSaveKey = () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      return;
    }
    credentialStore.trigger.setApiKey({ apiKey: trimmed });
    setKeyDraft("");
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
              <div
                className="mt-3 rounded-lg border border-red-500/25 bg-red-500/[0.07] p-3"
                role="alert"
              >
                <div className="flex items-start gap-2.5">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-red-400" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-red-200">The agent hit an error</p>
                    <pre className="mt-1 whitespace-pre-wrap wrap-break-word font-sans text-xs leading-5 text-red-300/90">
                      {error}
                    </pre>
                    <p className="mt-2 text-[11px] text-slate-500">
                      Try again. If it keeps failing, check the provider status or choose another
                      model.
                    </p>
                  </div>
                </div>
                {canRetry ? (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={handleRetry}
                      disabled={isBusy || !apiKey}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#173925] px-3 text-xs font-semibold text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCcw size={13} />
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <div ref={transcriptEndRef} />
          </div>

          {activeConfirmation ? (
            <div className="mx-3 mb-3 rounded-lg border border-[#64a3ff]/25 bg-[#1a202a] p-3 shadow-[0_8px_20px_rgba(0,0,0,0.16)]">
              <div className="flex items-start gap-2.5">
                <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-[#64a3ff]/10 text-[#64a3ff]">
                  <ShieldCheck size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64a3ff]">
                    Permission required
                  </p>
                  <p className="mt-0.5 text-xs font-medium text-slate-200">
                    Allow {activeConfirmation.request.toolName} to run this command?
                  </p>
                </div>
              </div>
              <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-slate-800 bg-[#0f1319] px-3 py-2 font-mono text-xs leading-5 text-slate-300">
                {activeConfirmation.request.summary}
              </pre>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolveConfirmation(activeConfirmation.id, false)}
                  className="h-8 rounded-md border border-slate-700 bg-transparent px-3 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 hover:text-white"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => resolveConfirmation(activeConfirmation.id, true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#173925] px-3 text-xs font-semibold text-[#58d88d] transition-colors hover:bg-[#1f4a31]"
                >
                  <Check size={13} />
                  Allow
                </button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-[#11151d] bg-[#13171e] p-3">
            <div className="rounded-lg border border-slate-700/80 bg-[#0f1319] shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-colors focus-within:border-[#64a3ff]/70 focus-within:ring-1 focus-within:ring-[#64a3ff]/25">
              {promptImages.length > 0 ? (
                <div className="flex gap-2 overflow-x-auto border-b border-slate-800/80 p-2">
                  {promptImages.map((image) => (
                    <div key={image.id} className="group relative size-14 shrink-0">
                      <img
                        src={image.dataUrl}
                        alt={image.name ?? "Pasted image"}
                        className="size-full rounded border border-slate-700 object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => agentStore.trigger.removeDraftImage({ id: image.id })}
                        className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full bg-slate-900 text-slate-300 shadow hover:bg-red-900 hover:text-red-100"
                        aria-label={`Remove ${image.name ?? "pasted image"}`}
                        title="Remove image"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <textarea
                value={promptInput}
                onChange={(event) => applyDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                disabled={isBusy || isReplayActive}
                aria-label="Message the agent"
                placeholder="Ask anything about this workspace"
                rows={2}
                className="h-14 min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
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
                      (!promptInput.trim() && promptImages.length === 0) || !apiKey || isReplayActive
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
        <div
          className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="mx-auto flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <p className="text-sm font-semibold text-slate-100">Agent settings</p>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="text-slate-500 hover:text-white"
                aria-label="Close settings"
              >
                <X size={16} />
              </button>
            </div>
            <div className="space-y-5 overflow-y-auto p-5">
              <div>
                <p className="text-sm font-medium text-slate-100">Model</p>
                <div className="relative mt-2">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-3 top-2.5 text-slate-500"
                  />
                  <input
                    type="search"
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Search OpenRouter models"
                    aria-label="Search OpenRouter models"
                    className="h-9 w-full rounded-md border border-slate-700 bg-[#11141c] pl-9 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-slate-500"
                  />
                </div>
                <div className="mt-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto rounded-md border border-slate-800 p-2">
                  {filteredModelOptions.map((option) => (
                    <label
                      key={option.id}
                      className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs text-slate-300 hover:bg-slate-800/70"
                    >
                      <input
                        type="radio"
                        name="agent-model"
                        checked={model === option.id}
                        onChange={() => agentStore.trigger.setModel({ model: option.id })}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="block truncate">{option.label}</span>
                        <span className="block truncate font-mono text-[10px] text-slate-600">
                          {option.id}
                          {!option.supportsImages ? " · no image input" : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                  {filteredModelOptions.length === 0 ? (
                    <p className="px-1.5 py-2 text-xs text-slate-500">
                      No models match “{modelQuery.trim()}”.
                    </p>
                  ) : null}
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  {isModelCatalogLoading
                    ? "Loading models from OpenRouter…"
                    : modelCatalogError ?? `${modelOptions.length} models from OpenRouter.`}
                </p>
                <p className="mt-2 text-[11px] text-slate-500">
                  Usage this session: {usage.inputTokens} in / {usage.outputTokens} out tokens.
                </p>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-100">API key</p>
                {/* ph-no-capture blocks this field from PostHog session replays so the
                    API key is never recorded, independent of the global maskAllInputs
                    setting (see posthog init in src/main.tsx). */}
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={apiKey ? "•••• (set) — paste to replace" : "sk-or-v1-..."}
                  className="ph-no-capture mt-2 h-9 w-full rounded-md border border-slate-700 bg-[#11141c] px-3 font-mono text-xs text-slate-100 outline-none focus:border-slate-500"
                />
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    disabled={!keyDraft.trim()}
                    onClick={handleSaveKey}
                    className="rounded-md bg-[#173925] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save
                  </button>
                  {apiKey ? (
                    <button
                      type="button"
                      onClick={() => credentialStore.trigger.clear()}
                      className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white"
                    >
                      Clear
                    </button>
                  ) : null}
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-100">Remember key</p>
                <div className="mt-2 flex flex-col gap-2">
                  {STORAGE_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className="flex items-start gap-2 text-xs text-slate-300"
                    >
                      <input
                        type="radio"
                        name="agent-credential-storage"
                        className="mt-0.5"
                        checked={credentialStorage === option.id}
                        onChange={() => credentialStore.trigger.setStorage({ storage: option.id })}
                      />
                      <span>
                        <span className="block">{option.label}</span>
                        <span className="block text-[11px] text-slate-500">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default AgentPanel;
