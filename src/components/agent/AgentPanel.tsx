import { useContext, useEffect, useRef, useState } from "react";
import { useSelector } from "@xstate/store-react";
import type Anthropic from "@anthropic-ai/sdk";
import { Bot, ChevronDown, ChevronUp, Send, Settings, Square, X } from "lucide-react";
import { WorkspaceStoreContext } from "../../stores/workspaceStore";
import {
  getAgentStore,
  selectError,
  selectMessages,
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
import { runAgentLoop } from "../../agent/agentLoop";
import { createChatRecorder } from "../../agent/chatRecording";
import { CODING_TOOLS } from "../../agent/tools";
import type { AgentModelId, ToolConfirmationRequest } from "../../agent/types";
import type { ChatMessage, ChatStatus } from "../../types/chat";
import type { CredentialStorage } from "../../agent/types";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";

interface PendingConfirmation {
  request: ToolConfirmationRequest;
  resolve: (approved: boolean) => void;
}

const MODEL_OPTIONS: { id: AgentModelId; label: string }[] = [
  { id: "claude-haiku-4-5", label: "Haiku 4.5 (fast)" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
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

function getMessageText(message: ChatMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function getToolUseBlocks(message: ChatMessage): Anthropic.ToolUseBlockParam[] {
  return message.content.filter(
    (block): block is Anthropic.ToolUseBlockParam => block.type === "tool_use",
  );
}

function getSoleToolResultBlock(message: ChatMessage): Anthropic.ToolResultBlockParam | null {
  const [block] = message.content;
  return message.content.length === 1 && block?.type === "tool_result" ? block : null;
}

function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  if (typeof block.content === "string") {
    return block.content;
  }
  if (!block.content) {
    return "";
  }
  return block.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("\n");
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  const candidate = record.path ?? record.command ?? record.pattern;
  return typeof candidate === "string" ? candidate : "";
}

function ToolUseChip({ block }: { block: Anthropic.ToolUseBlockParam }) {
  const summary = summarizeToolInput(block.input);

  return (
    <div className="ml-4 inline-flex max-w-full items-center gap-1.5 rounded-md bg-[#1e2129] px-2.5 py-1 font-mono text-[11px] text-slate-400">
      <span className="text-[#64a3ff]">{block.name}</span>
      {summary ? <span className="truncate text-slate-500">{summary}</span> : null}
    </div>
  );
}

function ToolResultRow({ block }: { block: Anthropic.ToolResultBlockParam }) {
  const [expanded, setExpanded] = useState(false);
  const text = toolResultText(block).trim();
  const isLong = text.length > 300;
  const shown = expanded || !isLong ? text : `${text.slice(0, 300)}…`;

  if (!text) {
    return null;
  }

  return (
    <div
      className={`ml-4 rounded-md border px-3 py-2 font-mono text-xs ${
        block.is_error
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

function TranscriptMessage({ message }: { message: ChatMessage }) {
  const toolResultBlock = getSoleToolResultBlock(message);

  if (toolResultBlock) {
    return <ToolResultRow block={toolResultBlock} />;
  }

  const text = getMessageText(message);
  const toolUseBlocks = getToolUseBlocks(message);

  return (
    <div className={message.role === "user" ? "flex justify-end" : ""}>
      <div className={message.role === "user" ? "max-w-[85%]" : "w-full"}>
        {text ? (
          <div
            className={`whitespace-pre-wrap wrap-break-word rounded-md px-3 py-2 text-[13px] leading-6 ${
              message.role === "user"
                ? "bg-[#233047] text-slate-100"
                : "bg-transparent text-slate-200"
            }`}
          >
            {text}
          </div>
        ) : null}
        {toolUseBlocks.length > 0 ? (
          <div className="mt-1 flex flex-col gap-1">
            {toolUseBlocks.map((block) => (
              <ToolUseChip key={block.id} block={block} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AgentPanel() {
  const workspaceStore = useContext(WorkspaceStoreContext);
  const agentStore = getAgentStore();
  const credentialStore = getAgentCredentialStore();
  const { handleChatEvent } = useNextEditorActions();
  const { isPlaying, isRecording } = useNextEditorMetadata();

  const liveMessages = useSelector(agentStore, (s) => selectMessages(s.context));
  const liveStatus = useSelector(agentStore, (s) => selectStatus(s.context));
  const replaySnapshot = useSelector(agentStore, (s) => selectReplaySnapshot(s.context));
  const error = useSelector(agentStore, (s) => selectError(s.context));
  const usage = useSelector(agentStore, (s) => selectUsage(s.context));
  const model = useSelector(agentStore, (s) => selectModel(s.context));
  const apiKey = useSelector(credentialStore, (s) => selectApiKey(s.context));
  const credentialStorage = useSelector(credentialStore, (s) => selectCredentialStorage(s.context));

  // Mirrors TerminalPanel's isPlaybackSnapshotActive: while replaying a recording
  // (and not live-recording over it), render the folded chat track instead of the
  // live agent store — the two never usefully coexist for one AgentPanel instance.
  // During replay the transcript comes only from the recorded chat track: a
  // recording with no agent activity shows an empty panel (fall back to `[]`, not
  // the live conversation). `setRecording` resets `replaySnapshot` to empty on
  // load so a chat-less recording never surfaces a previous replay's transcript.
  const isReplayActive = isPlaying && !isRecording;
  const messages = isReplayActive ? (replaySnapshot?.messages ?? []) : liveMessages;
  const status = isReplayActive ? (replaySnapshot?.status ?? "idle") : liveStatus;

  const [isCollapsed, setIsCollapsed] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [promptInput, setPromptInput] = useState("");
  const [confirmationQueue, setConfirmationQueue] = useState<PendingConfirmation[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const isBusy = status === "streaming" || status === "running-tool";
  const activeConfirmation = confirmationQueue[0] ?? null;

  const resolveConfirmation = (approved: boolean) => {
    setConfirmationQueue((queue) => {
      const [current, ...rest] = queue;
      current?.resolve(approved);
      return rest;
    });
  };

  const requestConfirmation = (request: ToolConfirmationRequest): Promise<boolean> =>
    new Promise((resolve) => {
      setConfirmationQueue((queue) => [...queue, { request, resolve }]);
    });

  const handleSubmit = async () => {
    const prompt = promptInput.trim();

    if (!prompt || isBusy || !apiKey || !workspaceStore || isReplayActive) {
      return;
    }

    setPromptInput("");
    agentStore.trigger.setError({ message: null });

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const history = agentStore.getSnapshot().context.messages;
    const recordChatDelta = createChatRecorder(agentStore, handleChatEvent);

    try {
      await runAgentLoop({
        apiKey,
        model,
        workspace: workspaceStore,
        tools: CODING_TOOLS,
        history,
        prompt,
        signal: controller.signal,
        requestConfirmation,
        onDelta: (delta) => {
          agentStore.trigger.applyDelta({ delta });
          recordChatDelta(delta);
        },
      });
    } catch (caughtError) {
      agentStore.trigger.setError({
        message: caughtError instanceof Error ? caughtError.message : String(caughtError),
      });
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    abortControllerRef.current?.abort();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
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
        className="flex shrink-0 flex-col overflow-hidden rounded-t-md bg-[#15191f]"
        data-cursor-replay-target="agent-panel"
      >
        <div className="flex items-center gap-2 border-b border-[#11151d] bg-[#1e2129] px-3 py-2.5">
          <Bot size={15} className="text-[#64a3ff]" />
          <span className="text-[13px] font-semibold text-white">Agent</span>
          <span className="truncate text-[11px] text-slate-500">{STATUS_LABEL[status]}</span>
          <button
            type="button"
            onClick={() => setIsSettingsOpen(true)}
            className="ml-auto inline-flex items-center justify-center text-slate-500 transition-colors hover:text-slate-200 size-8"
            aria-label="Open agent settings"
            title="Agent settings"
          >
            <Settings size={16} />
          </button>
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="inline-flex items-center justify-center text-slate-500 transition-colors hover:text-white size-8"
            aria-label={isCollapsed ? "Expand agent panel" : "Collapse agent panel"}
            title={isCollapsed ? "Expand agent panel" : "Collapse agent panel"}
          >
            {isCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>

        {!isCollapsed ? (
          <div className="flex h-80 flex-col bg-[#15191f]">
            {!apiKey && !isReplayActive ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
                <p className="text-xs text-slate-400">
                  Paste your Anthropic API key to start the coding agent. It's kept in memory only
                  unless you opt into persistence in settings.
                </p>
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder="sk-ant-api..."
                  className="mt-3 h-9 w-full max-w-xs rounded-md border border-slate-700 bg-[#11141c] px-3 font-mono text-xs text-slate-100 outline-none focus:border-slate-500"
                />
                <button
                  type="button"
                  disabled={!keyDraft.trim()}
                  onClick={handleSaveKey}
                  className="mt-2 w-full max-w-xs rounded-md bg-[#173925] py-1.5 text-xs font-bold uppercase tracking-wide text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Save key
                </button>
              </div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {messages.length === 0 ? (
                    <p className="px-1 text-xs text-slate-500">
                      Ask the agent to build or fix something in this workspace.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2">
                      {messages.map((message) => (
                        <TranscriptMessage key={message.id} message={message} />
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
                        onClick={() => resolveConfirmation(false)}
                        className="rounded-md px-3 py-1 text-xs font-semibold text-slate-400 hover:text-white"
                      >
                        Deny
                      </button>
                      <button
                        type="button"
                        onClick={() => resolveConfirmation(true)}
                        className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white hover:bg-amber-500"
                      >
                        Allow
                      </button>
                    </div>
                  </div>
                ) : null}

                {isReplayActive ? (
                  <div className="border-t border-[#11151d] px-3 py-2.5 text-center text-[11px] text-slate-500">
                    Replaying recorded transcript — read only.
                  </div>
                ) : (
                  <div className="flex items-end gap-2 border-t border-[#11151d] p-3">
                    <textarea
                      value={promptInput}
                      onChange={(event) => setPromptInput(event.target.value)}
                      onKeyDown={handleKeyDown}
                      disabled={isBusy}
                      placeholder="Ask the agent…"
                      rows={2}
                      className="h-16 min-h-16 flex-1 resize-none rounded-md border border-slate-700 bg-[#11141c] px-3 py-2 text-[13px] text-slate-100 outline-none focus:border-slate-500 disabled:opacity-60"
                    />
                    {isBusy ? (
                      <button
                        type="button"
                        onClick={handleStop}
                        className="inline-flex size-9 items-center justify-center rounded-md bg-red-900 text-red-200 transition-colors hover:bg-red-800"
                        aria-label="Stop"
                        title="Stop"
                      >
                        <Square size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleSubmit()}
                        disabled={!promptInput.trim()}
                        className="inline-flex size-9 items-center justify-center rounded-md bg-[#173925] text-[#58d88d] transition-colors hover:bg-[#1f4a31] disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Send"
                        title="Send"
                      >
                        <Send size={14} />
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}
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
                <input
                  type="password"
                  value={keyDraft}
                  onChange={(event) => setKeyDraft(event.target.value)}
                  placeholder={apiKey ? "•••• (set) — paste to replace" : "sk-ant-api..."}
                  className="mt-2 h-9 w-full rounded-md border border-slate-700 bg-[#11141c] px-3 font-mono text-xs text-slate-100 outline-none focus:border-slate-500"
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
