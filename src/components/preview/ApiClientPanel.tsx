import { useState } from "react";
import { useSelector } from "@xstate/store-react";
import { Clock, Loader2, Minus, Plus, Send, Trash2 } from "lucide-react";
import Editor from "@monaco-editor/react";
import { useApiClientStoreInstance } from "../../contexts/ApiClientStoreContext";
import {
  selectBody,
  selectHeaders,
  selectHistory,
  selectMethod,
  selectPath,
  selectRequestTab,
  selectResult,
  selectSending,
  type ApiClientHistoryEntry,
  type HttpMethod,
} from "../../stores/apiClientStore";
import type { ApiClientRequestTab } from "../../types/slides";

const HTTP_METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: "text-emerald-400",
  POST: "text-amber-400",
  PUT: "text-blue-400",
  PATCH: "text-purple-400",
  DELETE: "text-red-400",
};

function statusColor(status: number): string {
  if (status < 300) return "bg-emerald-500/20 text-emerald-300";
  if (status < 400) return "bg-amber-500/20 text-amber-300";
  return "bg-red-500/20 text-red-300";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatSize(text: string): string {
  const bytes = new Blob([text]).size;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function tryPrettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function detectLanguage(headers: [string, string][], body: string): string {
  const ct = headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (ct.includes("json") || (body.startsWith("{") && body.endsWith("}"))) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("css")) return "css";
  if (ct.includes("javascript")) return "javascript";
  if (ct.includes("xml")) return "xml";
  return "plaintext";
}

interface ApiClientPanelProps {
  onSend: () => void;
  runtimeReady: boolean;
  onRequestTabChange?: (tab: ApiClientRequestTab) => void;
  onInspectHistory?: (entry: ApiClientHistoryEntry) => void;
}

export default function ApiClientPanel({
  onSend,
  runtimeReady,
  onRequestTabChange,
  onInspectHistory,
}: ApiClientPanelProps) {
  const store = useApiClientStoreInstance();
  const method = useSelector(store, (s) => selectMethod(s.context));
  const path = useSelector(store, (s) => selectPath(s.context));
  const headers = useSelector(store, (s) => selectHeaders(s.context));
  const body = useSelector(store, (s) => selectBody(s.context));
  const sending = useSelector(store, (s) => selectSending(s.context));
  const result = useSelector(store, (s) => selectResult(s.context));
  const history = useSelector(store, (s) => selectHistory(s.context));
  const activeTab = useSelector(store, (s) => selectRequestTab(s.context));

  const selectTab = (tab: ApiClientRequestTab) => {
    store.trigger.setRequestTab({ tab });
    onRequestTabChange?.(tab);
  };

  const canSend = runtimeReady && !sending;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canSend) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#1a1e27] text-sm text-slate-200">
      {/* Waiting banner — the server isn't listening yet, so requests can't be sent. */}
      {!runtimeReady ? (
        <div className="flex items-center gap-2 border-b border-slate-800 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-300">
          <Loader2 size={12} className="animate-spin" />
          Waiting for the server to start…
        </div>
      ) : null}

      {/* Request line */}
      <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2">
        <select
          value={method}
          onChange={(e) => store.trigger.setMethod({ method: e.target.value as HttpMethod })}
          className={`h-8 rounded-md border border-slate-700 bg-[#242938] px-2 font-mono text-xs font-bold ${METHOD_COLORS[method]} focus:outline-none focus:ring-1 focus:ring-sky-500`}
        >
          {HTTP_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <input
          type="text"
          value={path}
          onChange={(e) => store.trigger.setPath({ path: e.target.value })}
          onKeyDown={handleKeyDown}
          placeholder="/api/endpoint"
          aria-label="Request path"
          className="h-8 min-w-0 flex-1 rounded-md border border-slate-700 bg-[#242938] px-2.5 font-mono text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
        />

        <button
          type="button"
          onClick={onSend}
          disabled={!canSend}
          title={runtimeReady ? undefined : "Waiting for the server to start"}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-sky-600 px-3 font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          Send
        </button>
      </div>

      {/* Request tabs */}
      <div className="flex items-center gap-1 border-b border-slate-800 px-3">
        <TabButton active={activeTab === "headers"} onClick={() => selectTab("headers")}>
          Headers{headers.length > 0 ? ` (${headers.length})` : ""}
        </TabButton>
        {method !== "GET" ? (
          <TabButton active={activeTab === "body"} onClick={() => selectTab("body")}>
            Body
          </TabButton>
        ) : null}
      </div>

      {/* Request tab content */}
      <div className="min-h-0 shrink-0 border-b border-slate-800">
        {activeTab === "headers" ? (
          <HeadersEditor
            headers={headers}
            onUpdate={(index, update) => store.trigger.updateHeader({ index, ...update })}
            onAdd={() => store.trigger.addHeader()}
            onRemove={(index) => store.trigger.removeHeader({ index })}
          />
        ) : null}
        {activeTab === "body" && method !== "GET" ? (
          <div className="h-36">
            <Editor
              height="100%"
              language="json"
              value={body}
              onChange={(v) => store.trigger.setBody({ body: v ?? "" })}
              theme="vs-dark"
              options={{
                minimap: { enabled: false },
                lineNumbers: "off",
                scrollBeyondLastLine: false,
                fontSize: 12,
                padding: { top: 8, bottom: 8 },
                renderLineHighlight: "none",
                overviewRulerLanes: 0,
                folding: false,
                wordWrap: "on",
              }}
            />
          </div>
        ) : null}
      </div>

      {/* Response */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {sending ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-slate-500">
            <Loader2 size={16} className="animate-spin" />
            Sending request…
          </div>
        ) : result ? (
          <ResponseView result={result} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-slate-600">
            Send a request to see the response
          </div>
        )}
      </div>

      {/* History */}
      {history.length > 0 ? (
        <div className="shrink-0 border-t border-slate-800">
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              History
            </span>
            <button
              type="button"
              onClick={() => store.trigger.reset()}
              className="text-slate-600 transition-colors hover:text-slate-400"
              title="Clear history"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div className="max-h-28 overflow-y-auto px-1 pb-1.5">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  store.trigger.selectFromHistory({ entry });
                  onInspectHistory?.(entry);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-slate-800"
              >
                <span className={`font-mono text-[11px] font-bold ${METHOD_COLORS[entry.method]}`}>
                  {entry.method}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-slate-400">
                  {entry.path}
                </span>
                {entry.result.ok ? (
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${statusColor(entry.result.response.status)}`}
                  >
                    {entry.result.response.status}
                  </span>
                ) : (
                  <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-red-300">
                    Error
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-xs font-semibold transition-colors ${
        active
          ? "border-sky-400 text-sky-300"
          : "border-transparent text-slate-500 hover:text-slate-300"
      }`}
    >
      {children}
    </button>
  );
}

function HeadersEditor({
  headers,
  onUpdate,
  onAdd,
  onRemove,
}: {
  headers: { key: string; value: string; enabled: boolean }[];
  onUpdate: (index: number, update: { key?: string; value?: string; enabled?: boolean }) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="max-h-36 overflow-y-auto p-2">
      {headers.map((h, i) => (
        <div key={i} className="mb-1 flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={h.enabled}
            onChange={(e) => onUpdate(i, { enabled: e.target.checked })}
            className="accent-sky-500"
          />
          <input
            type="text"
            value={h.key}
            onChange={(e) => onUpdate(i, { key: e.target.value })}
            placeholder="Header"
            className="h-7 w-1/3 rounded border border-slate-700 bg-[#242938] px-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <input
            type="text"
            value={h.value}
            onChange={(e) => onUpdate(i, { value: e.target.value })}
            placeholder="Value"
            className="h-7 min-w-0 flex-1 rounded border border-slate-700 bg-[#242938] px-2 font-mono text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="text-slate-600 transition-colors hover:text-red-400"
          >
            <Minus size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="mt-1 inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-300"
      >
        <Plus size={12} />
        Add header
      </button>
    </div>
  );
}

function ResponseView({ result }: { result: NonNullable<ReturnType<typeof selectResult>> }) {
  const [showHeaders, setShowHeaders] = useState(false);

  if (!result.ok) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="rounded bg-red-500/20 px-2.5 py-1 text-xs font-semibold text-red-300">
          Error
        </span>
        <span className="text-xs text-slate-400">{result.error.error}</span>
        <span className="flex items-center gap-1 text-[11px] text-slate-600">
          <Clock size={11} />
          {formatDuration(result.error.durationMs)}
        </span>
      </div>
    );
  }

  const { response } = result;
  const prettyBody = tryPrettyJson(response.body);
  const lang = detectLanguage(response.headers, response.body);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Status bar */}
      <div className="flex items-center gap-3 border-b border-slate-800 px-3 py-1.5">
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${statusColor(response.status)}`}>
          {response.status} {response.statusText}
        </span>
        <span className="flex items-center gap-1 text-[11px] text-slate-500">
          <Clock size={11} />
          {formatDuration(response.durationMs)}
        </span>
        <span className="text-[11px] text-slate-600">{formatSize(response.body)}</span>
        {response.headers.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowHeaders((v) => !v)}
            className="ml-auto text-[11px] text-slate-500 transition-colors hover:text-slate-300"
          >
            Headers ({response.headers.length})
          </button>
        ) : null}
      </div>

      {/* Response headers (collapsible) */}
      {showHeaders ? (
        <div className="max-h-24 shrink-0 overflow-y-auto border-b border-slate-800 bg-[#151820] px-3 py-1.5">
          {response.headers.map(([key, value], i) => (
            <div key={i} className="flex gap-2 font-mono text-[11px]">
              <span className="shrink-0 font-semibold text-slate-400">{key}:</span>
              <span className="min-w-0 break-all text-slate-500">{value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Response body */}
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language={lang}
          value={prettyBody}
          theme="vs-dark"
          options={{
            readOnly: true,
            minimap: { enabled: false },
            lineNumbers: "off",
            scrollBeyondLastLine: false,
            fontSize: 12,
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: "none",
            overviewRulerLanes: 0,
            folding: true,
            wordWrap: "on",
            domReadOnly: true,
          }}
        />
      </div>
    </div>
  );
}
