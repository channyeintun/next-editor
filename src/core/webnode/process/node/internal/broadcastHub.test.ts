// @vitest-environment node
// The hubs of a process's workers, linked as its threads are, over real
// MessageChannels: a message reaches every other channel of its name once.
import { afterEach, describe, expect, it } from "vitest";
import { createBroadcastHub, type BroadcastHub } from "./broadcastHub";

const unlinks: (() => void)[] = [];

afterEach(() => {
  for (const unlink of unlinks.splice(0)) {
    unlink();
  }
});

/** A hub for a thread that `parent` starts. */
function child(parent: BroadcastHub): BroadcastHub {
  const hub = createBroadcastHub();
  const link = parent.linkChild();
  unlinks.push(link.unlink);
  hub.linkParent(link.port);
  return hub;
}

/** A channel of `name` on `hub` that logs what it gets as `label:data`. */
function channel(hub: BroadcastHub, name: string, label: string, log: string[]): EventTarget {
  const target = new EventTarget();
  target.addEventListener("message", (event) => {
    log.push(`${label}:${String((event as MessageEvent).data)}`);
    void Promise.resolve().then(() => log.push(`${label}>p`));
  });
  hub.join(target, name);
  return target;
}

/** Lets the event loop turn until `done()` holds, for a second at most. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !done(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("the BroadcastChannel hub", () => {
  it("gives a channel a thread just opened what another thread posts right after", async () => {
    const main = createBroadcastHub();
    const thread = child(main);
    const log: string[] = [];
    const sender = new EventTarget();
    main.join(sender, "x");
    // Joined at once: no later step of the platform's can lose the message.
    channel(thread, "x", "thread", log);
    main.post(sender, "x", "m1");
    await until(() => log.length === 2);
    expect(log).toEqual(["thread:m1", "thread>p"]);
  });

  it("reaches the other channels of the name here, not the sender, each in a task of its own", async () => {
    const hub = createBroadcastHub();
    const log: string[] = [];
    const a = channel(hub, "x", "a", log);
    channel(hub, "x", "b", log);
    channel(hub, "x", "c", log);
    channel(hub, "y", "y", log);
    hub.post(a, "x", 1);
    hub.post(a, "x", 2);
    await until(() => log.length === 8);
    expect(log).toEqual(["b:1", "b>p", "c:1", "c>p", "b:2", "b>p", "c:2", "c>p"]);
  });

  it("gives nothing to a channel that left before its message came", async () => {
    const hub = createBroadcastHub();
    const log: string[] = [];
    const a = channel(hub, "x", "a", log);
    const b = channel(hub, "x", "b", log);
    channel(hub, "x", "c", log);
    hub.post(a, "x", 1);
    hub.leave(b);
    hub.post(a, "x", 2);
    // Each delivery is a task of its own, in order: b's came before c's.
    await until(() => log.includes("c:2"));
    expect(log.filter((entry) => !entry.endsWith(">p"))).toEqual(["c:1", "c:2"]);
  });

  it("passes a message along the tree of threads once, never back", async () => {
    const main = createBroadcastHub();
    const thread = child(main);
    const grandchild = child(thread);
    const sibling = child(main);
    const log: string[] = [];
    const sender = channel(thread, "x", "sender", log);
    channel(main, "x", "main", log);
    channel(grandchild, "x", "grandchild", log);
    channel(sibling, "x", "sibling", log);
    thread.post(sender, "x", "m");
    thread.post(sender, "x", "n");
    // Every link keeps its order: what comes behind 'n' would be an echo.
    await until(() => log.filter((entry) => entry.endsWith(":n")).length === 3);
    expect(log.filter((entry) => !entry.endsWith(">p")).sort()).toEqual([
      "grandchild:m",
      "grandchild:n",
      "main:m",
      "main:n",
      "sibling:m",
      "sibling:n",
    ]);
  });

  it("clones the message as it is posted: one that cannot be cloned throws, receivers or not", () => {
    const hub = createBroadcastHub();
    const sender = new EventTarget();
    hub.join(sender, "x");
    expect(() => hub.post(sender, "x", () => 1)).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
    channel(hub, "x", "b", []);
    expect(() => hub.post(sender, "x", () => 1)).toThrow(
      expect.objectContaining({ name: "DataCloneError" }),
    );
  });

  it("sends nothing to a thread whose link is gone", async () => {
    const main = createBroadcastHub();
    const thread = createBroadcastHub();
    const link = main.linkChild();
    thread.linkParent(link.port);
    const linked = child(main);
    const log: string[] = [];
    const sender = new EventTarget();
    main.join(sender, "x");
    channel(thread, "x", "thread", log);
    channel(linked, "x", "linked", log);
    link.unlink();
    main.post(sender, "x", "m");
    // The link was closed before the post: nothing can come on it later.
    await until(() => log.includes("linked:m"));
    expect(log.filter((entry) => !entry.endsWith(">p"))).toEqual(["linked:m"]);
  });
});
