export class AgentProviderError extends Error {
  readonly providerError: unknown;

  constructor(cause: unknown, providerError: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "AgentProviderError";
    this.providerError = providerError;
  }
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" ? (value as UnknownRecord) : null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function stringField(record: UnknownRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Provider failures can arrive as an HTTP SDK error, a response.failed SSE event,
 * or JSON embedded in `metadata.raw`. Keep the top-level message, but also walk the
 * known safe error fields so the useful upstream explanation is not discarded.
 */
export function formatAgentError(error: unknown): string {
  const root = asRecord(error);
  const primary = error instanceof Error ? error.message : stringField(root, "message");
  const messages: string[] = [];
  const details: string[] = [];
  const seen = new Set<unknown>();

  const addMessage = (value: unknown) => {
    if (typeof value !== "string") {
      return;
    }
    const message = value.trim();
    if (message && message !== primary && !messages.includes(message)) {
      messages.push(message);
    }
  };

  const visit = (value: unknown, depth = 0) => {
    if (depth > 6 || value == null || seen.has(value)) {
      return;
    }
    seen.add(value);

    const parsed = parseJson(value);
    if (parsed !== value) {
      visit(parsed, depth + 1);
      return;
    }
    if (typeof value === "string") {
      addMessage(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    const record = asRecord(value);
    if (!record) {
      return;
    }

    addMessage(record.message);
    addMessage(record.summary);

    const code = record.code;
    if ((typeof code === "string" || typeof code === "number") && !details.includes(`Code: ${code}`)) {
      details.push(`Code: ${code}`);
    }

    const provider = stringField(record, "provider_name") ?? stringField(record, "providerName");
    const providerLabel = provider ?? stringField(record, "provider");
    if (providerLabel && !details.includes(`Provider: ${providerLabel}`)) {
      details.push(`Provider: ${providerLabel}`);
    }

    // Deliberately restrict traversal to error-bearing fields. This avoids ever
    // serializing requests, headers, or other objects that may contain the API key.
    for (const key of [
      "providerError",
      "error",
      "cause",
      "data$",
      "body",
      "metadata",
      "raw",
      "openrouterMetadata",
      "attempts",
    ]) {
      if (key in record) {
        visit(record[key], depth + 1);
      }
    }
  };

  visit(error);

  const heading = primary?.trim() || "The agent request failed.";
  return [heading, ...messages, ...details].join("\n");
}
