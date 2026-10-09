import { useContext, useEffect, useId, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, Plus, Send, Settings, Square } from "lucide-react";
import { WorkspaceStoreContext } from "../../contexts/WorkspaceContext";
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
import type { ChatStatus } from "../../types/chat";
import {
  createChatImage,
  getClipboardImageFiles,
  MAX_CHAT_IMAGES,
} from "../../agent/imageAttachments";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";
import { useWorkspaceLoadVersion } from "../../hooks/useWorkspace";
import { createChatCheckpoint } from "../../agent/chatRecording";
import { dockContentSizeClassName } from "../terminalPanel/runtimeDockHelpers";
import AgentErrorNotice from "./AgentErrorNotice";
import AgentSettingsDialog from "./AgentSettingsDialog";
import TranscriptItem from "./AgentTranscript";
import DraftImageStrip from "./DraftImageStrip";
import ToolConfirmationCard from "./ToolConfirmationCard";
import { useAgentObservers } from "./useAgentObservers";
import { useOpenRouterModelCatalog } from "./useOpenRouterModelCatalog";

const STATUS_LABEL: Record<ChatStatus, string> = {
  idle: "Idle",
  streaming: "Streaming…",
  "running-tool": "Running tool…",
  "waiting-confirmation": "Waiting for confirmation…",
  done: "Done",
  error: "Error",
};

// Spoken through the header's status region. Errors are left out: AgentErrorNotice
// already announces them as an alert.
const STATUS_ANNOUNCEMENT: Partial<Record<ChatStatus, string>> = {
  streaming: "Agent is working",
  "running-tool": "Agent is working",
  "waiting-confirmation": "The agent needs your permission to run a command",
  done: "Agent finished",
};

function AgentPanel({ isFullHeight = false }: { isFullHeight?: boolean }) {
  const workspaceStore = useContext(WorkspaceStoreContext);
  const agentStore = getAgentStore();
  const credentialStore = getAgentCredentialStore();
  const sessionStore = getAgentSessionStore();
  const { handleChatEvent } = useNextEditorActions();
  const { isPlaying, isRecording } = useNextEditorMetadata();
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
  const messageInputRef = useRef<HTMLTextAreaElement | null>(null);
  const keyHintId = useId();
  const wasRecordingRef = useRef(false);

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

  // Called after the effects above so its fetch effect keeps its place in their order.
  const modelCatalog = useOpenRouterModelCatalog(isSettingsOpen);

  // Reflects the actual live run (for Send/Stop + read-only input); the status label/
  // spinner below tracks the displayed status, which during replay is the recorded one.
  const isBusy = isRunning;

  // When a run settles on its own, Stop is swapped back for Send. If Stop had focus
  // it went to the body with it, so bring the keyboard user back to the composer.
  // Only on the busy → idle edge, never on mount, and only when focus was lost.
  const wasBusyRef = useRef(isBusy);
  useEffect(() => {
    const wasBusy = wasBusyRef.current;
    wasBusyRef.current = isBusy;
    if (wasBusy && !isBusy && document.activeElement === document.body) {
      messageInputRef.current?.focus();
    }
  }, [isBusy]);

  const isActiveStatus =
    status === "streaming" || status === "running-tool" || status === "waiting-confirmation";
  const activeConfirmation = pending[0] ?? null;
  const isKeyHintShown = !apiKey && !isReplayActive;
  const selectedModelOption = modelCatalog.modelOptions.find((option) => option.id === model);
  const selectedModelLabel = selectedModelOption?.label ?? model;
  const observers = useAgentObservers(
    selectedModelLabel,
    selectedModelOption?.supportsImages ?? false,
  );

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
      observers,
    });
    // Starting the run swaps Send for Stop; keep focus in the (now read-only)
    // composer instead of letting it fall to the body with the unmounted button.
    messageInputRef.current?.focus();
  };

  const handleStop = () => {
    stopAgentRun();
    messageInputRef.current?.focus();
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
    // Paste still fires on a read-only field, so ignore it while a run is busy.
    if (isBusy || isReplayActive) {
      return;
    }
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
    // The Enter that commits an IME candidate (Burmese, CJK) belongs to the
    // composition, not the composer; sending on it would start a run with the
    // half-composed prompt.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  return (
    <>
      <div
        className={`flex ${dockContentSizeClassName(isFullHeight)} flex-col bg-[#15191f]`}
        data-cursor-replay-target="agent-panel"
      >
        <div className="flex min-h-11 items-center gap-2 border-b border-[#11151d] bg-[#191d25] px-4 py-2.5">
          <Bot size={14} className="text-[#64a3ff]" />
          <span className="truncate text-[11px] font-semibold text-slate-300">
            {STATUS_LABEL[status]}
          </span>
          {/* Always mounted so screen readers hear each change; silent during lesson
              replay so recorded statuses do not talk over the narration. */}
          <span role="status" className="sr-only">
            {isReplayActive ? "" : (STATUS_ANNOUNCEMENT[status] ?? "")}
          </span>
          {isActiveStatus ? (
            <span
              aria-hidden="true"
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
          {/* relative: the transcript's sr-only labels are absolutely positioned, so
              they must scroll with it rather than stretch the page's overflow.
              Focusable so the keyboard can scroll it when no message has a control
              (Safari does not focus scroll containers on its own); the ring is drawn
              inside so the dock does not clip it. */}
          <div
            tabIndex={0}
            role="region"
            aria-label="Agent conversation"
            className="relative min-h-0 flex-1 overflow-y-auto p-3 focus-visible:outline-offset-[-2px]"
          >
            {items.length === 0 ? (
              <p className="px-1 text-xs text-slate-300">
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
              onResolve={(approved) => {
                resolveConfirmation(activeConfirmation.id, approved);
                // The answered card unmounts with the focused Allow/Deny button.
                messageInputRef.current?.focus();
              }}
            />
          ) : null}

          <div className="border-t border-[#11151d] bg-[#13171e] p-3">
            <div className="rounded-lg border border-slate-700/80 bg-[#0f1319] shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-colors focus-within:border-[#64a3ff]/70 focus-within:ring-1 focus-within:ring-[#64a3ff]/25">
              <DraftImageStrip
                images={promptImages}
                onRemove={(id) => agentStore.trigger.removeDraftImage({ id })}
              />
              <textarea
                ref={messageInputRef}
                value={promptInput}
                onChange={(event) => applyDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={(event) => void handlePaste(event)}
                disabled={isReplayActive}
                readOnly={isBusy}
                aria-label="Message the agent"
                placeholder="Ask anything about this workspace"
                rows={2}
                className="h-14 min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-400 read-only:cursor-wait disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div role="status">
                {attachmentError ? (
                  <p className="px-3 pb-2 text-[11px] text-amber-400">{attachmentError}</p>
                ) : null}
              </div>
              {isKeyHintShown ? (
                <p id={keyHintId} className="px-3 pb-2 text-[11px] text-slate-400">
                  Add an OpenRouter API key in agent settings to send messages.
                </p>
              ) : null}
              <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  disabled={isReplayActive}
                  className="max-w-[calc(100%-3rem)] truncate rounded px-1.5 py-1 text-[11px] font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Choose agent model"
                >
                  {selectedModelLabel}
                </button>
                {/* Keyed so the swap really unmounts the focused button rather than
                    turning a focused Stop into a disabled Send in place. */}
                {isBusy && !isReplayActive ? (
                  <button
                    key="stop"
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
                    key="send"
                    type="button"
                    onClick={() => void handleSubmit()}
                    disabled={
                      (!promptInput.trim() && promptImages.length === 0) ||
                      !apiKey ||
                      isReplayActive
                    }
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded bg-[#58d88d] text-[#0b2416] transition-colors hover:bg-[#7ce5a5] disabled:cursor-not-allowed disabled:bg-[#27382f] disabled:text-slate-500"
                    aria-label="Send message"
                    aria-describedby={isKeyHintShown ? keyHintId : undefined}
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
