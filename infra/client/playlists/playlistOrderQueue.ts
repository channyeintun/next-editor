import { reorderPlaylistLessons } from "./playlistsApi";

/**
 * Saves a playlist's order as the author rearranges it, one request at a time
 * per playlist. Each save sends the whole order, so while one is in flight
 * only the newest order waits behind it: ten quick moves cost two requests,
 * and an older order can never land after a newer one. The queue lives
 * outside any component, so closing the manage panel mid-save loses nothing.
 */

interface PendingOrder {
  lessonIds: string[];
  settle: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
}

interface PlaylistQueue {
  inFlight: boolean;
  next: PendingOrder | null;
}

const queues = new Map<string, PlaylistQueue>();

/** Hands an order to the playlist's queue; settles once a request carrying it (or a newer order) does. */
export function savePlaylistOrder(
  playlistId: string,
  lessonIds: string[],
  send: (playlistId: string, lessonIds: string[]) => Promise<void> = reorderPlaylistLessons,
): Promise<void> {
  const queue = queues.get(playlistId) ?? { inFlight: false, next: null };
  queues.set(playlistId, queue);
  return new Promise<void>((resolve, reject) => {
    // A newer order replaces the waiting one; whoever waited for that one now
    // waits for this, since this request carries their change too.
    queue.next = {
      lessonIds,
      settle: [...(queue.next?.settle ?? []), { resolve, reject }],
    };
    if (!queue.inFlight) void drain(playlistId, queue, send);
  });
}

async function drain(
  playlistId: string,
  queue: PlaylistQueue,
  send: (playlistId: string, lessonIds: string[]) => Promise<void>,
): Promise<void> {
  queue.inFlight = true;
  while (queue.next) {
    const order = queue.next;
    queue.next = null;
    let failure: unknown = null;
    await send(playlistId, order.lessonIds).catch((error: unknown) => {
      failure = error ?? new Error("Saving the playlist order failed");
    });
    for (const waiter of order.settle) {
      if (failure) waiter.reject(failure);
      else waiter.resolve();
    }
  }
  queue.inFlight = false;
  queues.delete(playlistId);
}
