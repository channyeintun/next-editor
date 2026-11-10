import type { z } from "zod";

// Plumbing the room and voice Durable Objects share: their hibernatable
// sockets, the canonical session the Worker hands them in a header, their
// per-second message windows and a per-user connection budget.

const WEBSOCKET_OPEN = 1;

/**
 * How long a socket's last D1 access check stays fresh; a message after that
 * re-reads the member's room access from D1 before it is handled.
 */
export const ACCESS_REVALIDATION_INTERVAL_MS = 5_000;

/**
 * Concurrent sockets one account may hold on one room or voice object, beside
 * the one a reconnect replaces. Every budget those objects keep (sync answers,
 * awareness and update windows, roster broadcasts) is per socket, so this is
 * what stops one member multiplying them, and the fan-out cost of every
 * broadcast, by opening sockets under fresh session IDs. Generous enough for a
 * laptop plus a phone, plus a lingering socket not yet reaped.
 */
export const MAX_SOCKETS_PER_USER = 4;

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
 * The count a per-second rate window holds after one more message in
 * `second`: the stored count plus one while the window is still that second,
 * otherwise a new window starting at one.
 */
export function rateWindowCount(
  windowSecond: number | undefined,
  windowCount: number | undefined,
  second: number,
): number {
  return windowSecond === second ? (windowCount ?? 0) + 1 : 1;
}

/**
 * Frames per socket in the current second, for frames the socket's attachment
 * does not count. It lives in memory, so it restarts when the object
 * hibernates or is evicted; a socket that floods keeps the object awake.
 */
export class SocketFrameWindow {
  private readonly windows = new WeakMap<WebSocket, { second: number; count: number }>();

  /** Counts one frame from `socket`; false once it is over `limitPerSecond`. */
  consume(socket: WebSocket, limitPerSecond: number, now = Date.now()): boolean {
    const second = Math.floor(now / 1000);
    const window = this.windows.get(socket);
    const count = rateWindowCount(window?.second, window?.count, second);
    this.windows.set(socket, { second, count });
    return count <= limitPerSecond;
  }
}

/**
 * When each socket is next due an access recheck because the object sends it
 * something. Rechecks otherwise run only on a frame the socket sends, so a
 * member who only listens (pings are answered without waking the object) kept
 * receiving everything after losing access whenever no /control reached their
 * socket. It lives in memory, so after a wake-up the first send rechecks.
 */
export class QuietSocketRevalidation {
  private readonly dueAt = new WeakMap<WebSocket, number>();

  /**
   * Whether `socket` is due now; a due socket's next check is one interval
   * away. `accessCheckedAt` is read only when the socket is not yet tracked.
   */
  due(socket: WebSocket, accessCheckedAt: () => number | undefined, now = Date.now()): boolean {
    let dueAt = this.dueAt.get(socket);
    if (dueAt === undefined) {
      dueAt = (accessCheckedAt() ?? 0) + ACCESS_REVALIDATION_INTERVAL_MS;
      this.dueAt.set(socket, dueAt);
    }
    if (now < dueAt) return false;
    this.dueAt.set(socket, now + ACCESS_REVALIDATION_INTERVAL_MS);
    return true;
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
