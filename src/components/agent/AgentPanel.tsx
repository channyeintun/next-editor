import { useContext, useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import { Bot, Plus, Send, Settings, Square, X } from "lucide-react";
import { WorkspaceStoreContext } from "../../stores/workspaceStore";
import {
  getAgentStore,
  selectDraft,
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
  resolveConfirmation,
  selectIsRunning,
  selectPending,
  startAgentRun,
  stopAgentRun,
} from "../../agent/agentSession";
import type { AgentModelId, CredentialStorage } from "../../agent/types";
import type { ChatItem, ChatStatus } from "../../types/chat";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";

const MODEL_OPTIONS: { id: AgentModelId; label: string }[] = [
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (fast)" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free)" },
];

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
  const text = item.output.trim();
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
  if (!item.text) {
    return null;
  }

  return (
    <div className={item.role === "user" ? "flex justify-end" : ""}>
      <div className={item.role === "user" ? "max-w-[85%]" : "w-full"}>
        <div
          className={`whitespace-pre-wrap wrap-break-word rounded-md px-3 py-2 text-[13px] leading-6 ${
            item.role === "user" ? "bg-[#233047] text-slate-100" : "bg-transparent text-slate-200"
          }`}
        >
          {item.text}
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

  const liveItems = useSelector(agentStore, (s) => selectItems(s.context));
  const liveStatus = useSelector(agentStore, (s) => selectStatus(s.context));
  const liveDraft = useSelector(agentStore, (s) => selectDraft(s.context));
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

  // While replaying a recording (and not live-recording over it), render the folded
  // chat track instead of the live agent store. A recording with no agent activity
  // shows an empty panel (fall back to `[]`, not the live conversation).
  const isReplayActive = isPlaying && !isRecording;
  const items = isReplayActive ? (replaySnapshot?.items ?? []) : liveItems;
  const status = isReplayActive ? (replaySnapshot?.status ?? "idle") : liveStatus;
  const promptInput = isReplayActive ? (replaySnapshot?.draft ?? "") : liveDraft;

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const wasRecordingRef = useRef(false);

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

  // Reflects the actual live run (for Send/Stop + input disable); the status label/
  // spinner below tracks the displayed status, which during replay is the recorded one.
  const isBusy = isRunning;
  const isActiveStatus =
    status === "streaming" || status === "running-tool" || status === "waiting-confirmation";
  const activeConfirmation = pending[0] ?? null;

  const applyDraft = (text: string) => {
    const delta = { k: "draft", text } as const;
    agentStore.trigger.applyDelta({ delta });
    handleChatEvent(delta);
  };

  const handleSubmit = () => {
    const prompt = promptInput.trim();

    if (!prompt || isBusy || !apiKey || !workspaceStore || isReplayActive) {
      return;
    }

    applyDraft("");
    void startAgentRun({ apiKey, model, workspace: workspaceStore, prompt, handleChatEvent });
  };

  const handleStop = () => {
    stopAgentRun();
  };

  const handleNewChat = () => {
    if (isBusy || isReplayActive) {
      return;
    }
    agentStore.trigger.reset();
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
            {error ? (
              <div className="mt-2 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            ) : null}
            <div ref={transcriptEndRef} />
          </div>

          {activeConfirmation ? (
            <div className="mx-3 mb-2 rounded-md border border-amber-800 bg-amber-950/40 px-3 py-2">
              <p className="text-xs font-semibold text-amber-300">
                Run this {activeConfirmation.request.toolName} command?
              </p>
              <pre className="mt-1 whitespace-pre-wrap wrap-break-word font-mono text-xs text-amber-200">
                {activeConfirmation.request.summary}
              </pre>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => resolveConfirmation(activeConfirmation.id, false)}
                  className="rounded-md px-3 py-1 text-xs font-semibold text-slate-400 hover:text-white"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => resolveConfirmation(activeConfirmation.id, true)}
                  className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-500"
                >
                  Allow
                </button>
              </div>
            </div>
          ) : null}

          <div className="border-t border-[#11151d] bg-[#13171e] p-3">
            <div className="rounded-lg border border-slate-700/80 bg-[#0f1319] shadow-[0_8px_20px_rgba(0,0,0,0.18)] transition-colors focus-within:border-[#64a3ff]/70 focus-within:ring-1 focus-within:ring-[#64a3ff]/25">
              <textarea
                value={promptInput}
                onChange={(event) => applyDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isBusy || isReplayActive}
                aria-label="Message the agent"
                placeholder="Ask anything about this workspace"
                rows={2}
                className="h-14 min-h-14 w-full resize-none bg-transparent px-3 py-2.5 text-[13px] leading-5 text-slate-100 outline-none placeholder:text-slate-600 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <div className="flex items-center justify-between gap-2 border-t border-slate-800/80 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setIsSettingsOpen(true)}
                  disabled={isReplayActive}
                  className="max-w-[calc(100%-3rem)] truncate rounded px-1.5 py-1 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300 disabled:cursor-not-allowed disabled:opacity-60"
                  title="Choose agent model"
                >
                  {MODEL_OPTIONS.find((option) => option.id === model)?.label ?? "Choose model"}
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
                    disabled={!promptInput.trim() || !apiKey || isReplayActive}
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
                <div className="mt-2 flex flex-col gap-1.5">
                  {MODEL_OPTIONS.map((option) => (
                    <label
                      key={option.id}
                      className="flex items-center gap-2 text-xs text-slate-300"
                    >
                      <input
                        type="radio"
                        name="agent-model"
                        checked={model === option.id}
                        onChange={() => agentStore.trigger.setModel({ model: option.id })}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
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
