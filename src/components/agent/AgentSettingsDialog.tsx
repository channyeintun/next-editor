import { useSelector } from "@xstate/store-react";
import { Search, X } from "lucide-react";
import { useId, useRef } from "react";
import { getAgentStore, selectModel, selectUsage } from "../../agent/agentStore";
import {
  getAgentCredentialStore,
  selectApiKey,
  selectCredentialStorage,
} from "../../agent/credentials";
import { filterModelOptions } from "../../agent/modelCatalog";
import type { CredentialStorage } from "../../agent/types";
import ModalShell from "../ModalShell";
import type { OpenRouterModelCatalog } from "./useOpenRouterModelCatalog";

const STORAGE_OPTIONS: { id: CredentialStorage; label: string; description: string }[] = [
  { id: "memory", label: "Memory only", description: "Cleared on reload. Safest." },
  {
    id: "session",
    label: "This tab",
    description: "Survives reload, cleared when the tab closes.",
  },
  { id: "local", label: "This device", description: "Persists across sessions on this browser." },
];

function ModelSection({
  catalog,
  query,
  onQueryChange,
}: {
  catalog: OpenRouterModelCatalog;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const agentStore = getAgentStore();
  const model = useSelector(agentStore, (s) => selectModel(s.context));
  const usage = useSelector(agentStore, (s) => selectUsage(s.context));
  const { modelOptions, isModelCatalogLoading, modelCatalogError } = catalog;
  const filteredModelOptions = filterModelOptions(modelOptions, query);

  return (
    <div>
      <p className="text-sm font-medium text-slate-100">Model</p>
      <div className="relative mt-2">
        <Search size={14} className="pointer-events-none absolute left-3 top-2.5 text-slate-500" />
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search OpenRouter models"
          aria-label="Search OpenRouter models"
          className="h-9 w-full rounded-md border border-slate-700 bg-[#11141c] pl-9 pr-3 text-xs text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500"
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
          <p className="px-1.5 py-2 text-xs text-slate-500">No models match “{query.trim()}”.</p>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        {isModelCatalogLoading
          ? "Loading models from OpenRouter…"
          : (modelCatalogError ?? `${modelOptions.length} models from OpenRouter.`)}
      </p>
      <p className="mt-2 text-[11px] text-slate-500">
        Usage this session: {usage.inputTokens} in / {usage.outputTokens} out tokens.
      </p>
    </div>
  );
}

function ApiKeySection({
  keyDraft,
  onKeyDraftChange,
}: {
  keyDraft: string;
  onKeyDraftChange: (keyDraft: string) => void;
}) {
  const credentialStore = getAgentCredentialStore();
  const apiKey = useSelector(credentialStore, (s) => selectApiKey(s.context));
  const keyInputId = useId();
  const keyStatusId = `${keyInputId}-status`;
  // Save goes disabled and Clear unmounts once they act, so focus moves back to
  // the field instead of falling to the page.
  const keyInputRef = useRef<HTMLInputElement>(null);

  const handleSaveKey = () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) {
      return;
    }
    credentialStore.trigger.setApiKey({ apiKey: trimmed });
    onKeyDraftChange("");
    keyInputRef.current?.focus();
  };

  const handleClearKey = () => {
    credentialStore.trigger.clear();
    keyInputRef.current?.focus();
  };

  return (
    <div>
      <label htmlFor={keyInputId} className="block text-sm font-medium text-slate-100">
        API key
      </label>
      {/* ph-no-capture blocks this field from PostHog session replays so the
          API key is never recorded, independent of the global maskAllInputs
          setting (see posthog init in src/utils/posthogClient.ts). */}
      <input
        ref={keyInputRef}
        id={keyInputId}
        type="password"
        autoComplete="off"
        aria-describedby={apiKey ? keyStatusId : undefined}
        value={keyDraft}
        onChange={(event) => onKeyDraftChange(event.target.value)}
        placeholder={apiKey ? "•••• (set) — paste to replace" : "sk-or-v1-..."}
        className="ph-no-capture mt-2 h-9 w-full rounded-md border border-slate-700 bg-[#11141c] px-3 font-mono text-xs text-slate-100 outline-none focus:border-slate-500"
      />
      {apiKey ? (
        <p id={keyStatusId} className="mt-1 text-[11px] text-slate-400">
          A key is saved. Paste a new one to replace it.
        </p>
      ) : null}
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
            onClick={handleClearKey}
            className="rounded-md px-3 py-1.5 text-xs font-semibold text-slate-400 hover:text-white"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

function KeyStorageSection() {
  const credentialStore = getAgentCredentialStore();
  const credentialStorage = useSelector(credentialStore, (s) => selectCredentialStorage(s.context));

  return (
    <div>
      <p className="text-sm font-medium text-slate-100">Remember key</p>
      <div className="mt-2 flex flex-col gap-2">
        {STORAGE_OPTIONS.map((option) => (
          <label key={option.id} className="flex items-start gap-2 text-xs text-slate-300">
            <input
              type="radio"
              name="agent-credential-storage"
              className="mt-0.5"
              checked={credentialStorage === option.id}
              onChange={() => credentialStore.trigger.setStorage({ storage: option.id })}
            />
            <span>
              <span className="block">{option.label}</span>
              <span className="block text-[11px] text-slate-500">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * The agent's model, OpenRouter key and key storage. The search text and the unsaved
 * key are the caller's state, so both survive closing and reopening the dialog.
 */
export default function AgentSettingsDialog({
  modelCatalog,
  modelQuery,
  onModelQueryChange,
  keyDraft,
  onKeyDraftChange,
  onClose,
}: {
  modelCatalog: OpenRouterModelCatalog;
  modelQuery: string;
  onModelQueryChange: (query: string) => void;
  keyDraft: string;
  onKeyDraftChange: (keyDraft: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();

  return (
    <ModalShell maxWidthClassName="max-w-md" labelledBy={titleId} onDismiss={onClose}>
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
        <h2 id={titleId} className="text-sm font-semibold text-slate-100">
          Agent settings
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-500 hover:text-white"
          aria-label="Close settings"
        >
          <X size={16} />
        </button>
      </div>
      <div className="space-y-5 overflow-y-auto p-5">
        <ModelSection
          catalog={modelCatalog}
          query={modelQuery}
          onQueryChange={onModelQueryChange}
        />
        <ApiKeySection keyDraft={keyDraft} onKeyDraftChange={onKeyDraftChange} />
        <KeyStorageSection />
      </div>
    </ModalShell>
  );
}
