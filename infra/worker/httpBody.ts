export type LimitedBody =
  | { status: "ok"; text: string }
  | { status: "too-large" }
  | { status: "read-error" };

/**
 * Read a request or response body while enforcing a byte ceiling, so neither
 * a client nor an upstream service can stream an unbounded payload into
 * memory before JSON parsing. Shared by the playground proxy routes.
 */
export async function readBodyWithLimit(
  message: Pick<Request, "body" | "headers">,
  maxBytes: number,
): Promise<LimitedBody> {
  const contentLengthHeader = message.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { status: "too-large" };
    }
  }

  if (!message.body) {
    return { status: "ok", text: "" };
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
  return { status: "ok", text: new TextDecoder().decode(bytes) };
}
