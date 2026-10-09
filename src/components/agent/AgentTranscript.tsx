import { useState } from "react";
import type { ChatItem } from "../../types/chat";
import { formatToolResultOutput } from "./toolResultOutput";

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
      <span className="sr-only">Tool call: </span>
      <span className="text-[#82b4ff]">{item.name}</span>
      {summary ? <span className="truncate text-slate-300">{summary}</span> : null}
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
          : "border-slate-800 bg-[#171b22] text-slate-300"
      }`}
    >
      <span className="sr-only">{item.isError ? "Tool error: " : "Tool output: "}</span>
      <pre className="whitespace-pre-wrap wrap-break-word">{shown}</pre>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] font-semibold text-slate-300 hover:text-slate-100"
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
          {/* Who wrote it is otherwise shown only by alignment and colour. */}
          <span className="sr-only">{item.role === "user" ? "You said: " : "Agent: "}</span>
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

export default TranscriptItem;
