import { describe, expect, it } from "vite-plus/test";
import { savePlaylistOrder } from "./playlistOrderQueue";

/** A send whose requests stay open until the test settles them, in order. */
function heldSend() {
  const sent: string[][] = [];
  const pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  const send = (_playlistId: string, lessonIds: string[]) => {
    sent.push(lessonIds);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  };
  return { sent, pending, send };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("savePlaylistOrder", () => {
  it("sends one order at a time and only the newest of those waiting", async () => {
    const { sent, pending, send } = heldSend();

    const first = savePlaylistOrder("p1", ["a", "b"], send);
    const second = savePlaylistOrder("p1", ["b", "a"], send);
    const third = savePlaylistOrder("p1", ["b", "a", "c"], send);
    expect(sent).toEqual([["a", "b"]]);

    pending[0].resolve();
    await first;
    await flush();
    // The second order was superseded before it was sent.
    expect(sent).toEqual([
      ["a", "b"],
      ["b", "a", "c"],
    ]);

    pending[1].resolve();
    await expect(Promise.all([second, third])).resolves.toEqual([undefined, undefined]);
  });

  it("rejects the orders a failed request carried, and keeps serving later ones", async () => {
    const { sent, pending, send } = heldSend();

    const failed = savePlaylistOrder("p2", ["a"], send);
    pending[0].reject(new Error("offline"));
    await expect(failed).rejects.toThrow("offline");

    const next = savePlaylistOrder("p2", ["b"], send);
    expect(sent).toEqual([["a"], ["b"]]);
    pending[1].resolve();
    await expect(next).resolves.toBeUndefined();
  });

  it("keeps each playlist's queue separate", () => {
    const { sent, send } = heldSend();

    void savePlaylistOrder("p3", ["a"], send);
    void savePlaylistOrder("p4", ["b"], send);

    expect(sent).toEqual([["a"], ["b"]]);
  });
});
