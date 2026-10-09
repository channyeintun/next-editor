export type LimitedBytes =
  | { status: "ok"; bytes: Uint8Array }
  | { status: "too-large" }
  | { status: "read-error" };

export type LimitedBody =
  | { status: "ok"; text: string }
  | { status: "too-large" }
  | { status: "read-error" };

/**
 * Read a request or response body while enforcing a byte ceiling, so neither
 * a client nor an upstream service can stream an unbounded payload into
 * memory. A declared Content-Length over the limit is refused before reading;
 * a missing body reads as zero bytes.
 */
export async function readBytesWithLimit(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<LimitedBytes> {
  const contentLengthHeader = message.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { status: "too-large" };
    }
  }

  if (!message.body) {
    return { status: "ok", bytes: new Uint8Array(0) };
  }

  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { status: "too-large" };
      }
      chunks.push(value);
    }
  } catch {
    return { status: "read-error" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { status: "ok", bytes };
}

/** readBytesWithLimit, decoded as UTF-8 (malformed sequences become U+FFFD). */
export async function readBodyWithLimit(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<LimitedBody> {
  const body = await readBytesWithLimit(message, maxBytes);
  return body.status === "ok" ? { status: "ok", text: new TextDecoder().decode(body.bytes) } : body;
}

export type LimitedJson =
  | { status: "ok"; value: unknown }
  | { status: "too-large" }
  | { status: "read-error" }
  | { status: "invalid-json" };

/**
 * readBodyWithLimit, parsed as JSON. Each status is left to the caller to
 * answer, so every route keeps its own messages and codes; a missing body
 * reads as "" and so as invalid JSON.
 */
export async function readJsonWithLimit(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<LimitedJson> {
  const body = await readBodyWithLimit(message, maxBytes);
  if (body.status !== "ok") return body;
  try {
    return { status: "ok", value: JSON.parse(body.text) as unknown };
  } catch {
    return { status: "invalid-json" };
  }
}

/** A parsed JSON value that is an object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
