import type { z } from "zod";

// Plumbing the room and voice Durable Objects share: their hibernatable
// sockets, the canonical session the Worker hands them in a header, and a
// per-user connection budget.

const WEBSOCKET_OPEN = 1;

export function isOpen(socket: WebSocket): boolean {
  return socket.readyState === WEBSOCKET_OPEN;
}

/** Whether `roomId` is the room this object was addressed by (getByName). */
export function isCurrentRoom(ctx: DurableObjectState, roomId: string): boolean {
  const objectName = ctx.id.name;
  return !objectName || objectName === roomId;
}

/** `value`, validated, as URI-encoded JSON for a header the object reads back. */
export function encodeHeaderJson<Schema extends z.ZodType>(
  schema: Schema,
  value: z.input<Schema>,
): string {
  return encodeURIComponent(JSON.stringify(schema.parse(value)));
}

/** The header's value if it is present, decodes and matches `schema`; null otherwise. */
export function decodeHeaderJson<Schema extends z.ZodType>(
  schema: Schema,
  request: Request,
  header: string,
): z.output<Schema> | null {
  const encoded = request.headers.get(header);
  if (!encoded) return null;
  try {
    const result = schema.safeParse(JSON.parse(decodeURIComponent(encoded)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Connection attempts per user in the current minute. It lives in memory, so
 * it restarts when the object hibernates or is evicted.
 */
export class ConnectionQuota {
  private readonly perMinute: number;
  private minute = 0;
  private readonly counts = new Map<string, number>();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /** Counts one attempt by `userId`; false once they are over the budget. */
  consume(userId: string): boolean {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.minute !== minute) {
      this.minute = minute;
      this.counts.clear();
    }
    const count = (this.counts.get(userId) ?? 0) + 1;
    this.counts.set(userId, count);
    return count <= this.perMinute;
  }
}
