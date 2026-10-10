import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { PlaygroundClientBinding } from "../runtime/playgroundLanguage";
import { usePlaygroundRunner } from "./usePlaygroundRunner";

type FakeErrorKind = "rate-limited" | "unavailable" | "aborted";

class FakeServiceError extends Error {
  readonly kind: FakeErrorKind;

  constructor(kind: FakeErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A client whose requests stay pending until the test settles them, like a slow service. */
class FakeClient {
  readonly pending: Array<{ resolve: (value: string) => void; reject: (error: unknown) => void }> =
    [];
  stopped = 0;
  started = 0;

  run(): Promise<string> {
    this.started += 1;
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  /** Like a real client's run: starting one aborts the request still pending. */
  runAlone(): Promise<string> {
    for (const request of this.pending.splice(0)) {
      request.reject(new FakeServiceError("aborted", "superseded"));
    }
    return this.run();
  }

  stop() {
    this.stopped += 1;
    for (const request of this.pending.splice(0)) {
      request.reject(new FakeServiceError("aborted", "superseded"));
    }
  }
}

function renderRunner() {
  const clients: FakeClient[] = [];
  const binding: PlaygroundClientBinding<FakeClient, FakeErrorKind> = {
    create: () => {
      const client = new FakeClient();
      clients.push(client);
      return client;
    },
    stop: (client) => client.stop(),
    ServiceError: FakeServiceError,
  };
  const view = renderHook(() =>
    usePlaygroundRunner<FakeClient, "run" | "format", FakeErrorKind>(binding),
  );
  const client = () => {
    const [only] = clients;
    if (!only) throw new Error("No client was created");
    return only;
  };
  return { ...view, clients, client };
}

describe("usePlaygroundRunner", () => {
  it("reports the result and clears the busy operation", async () => {
    const { result, client } = renderRunner();

    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.request("run", (c) => c.run());
    });
    expect(result.current.activeOperation).toBe("run");

    await act(async () => {
      client().pending[0]?.resolve("hello");
      await outcome;
    });

    await expect(outcome).resolves.toEqual({ kind: "result", result: "hello" });
    expect(result.current.activeOperation).toBeNull();
  });

  it("lets a newer request own the busy flag when an older one resolves late", async () => {
    const { result, client } = renderRunner();

    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.request("run", (c) => c.run());
      second = result.current.request("format", (c) => c.run());
    });

    await act(async () => {
      client().pending[0]?.resolve("stale");
      await first;
    });
    await expect(first).resolves.toEqual({ kind: "superseded" });
    expect(result.current.activeOperation).toBe("format");

    await act(async () => {
      client().pending[1]?.resolve("formatted");
      await second;
    });
    await expect(second).resolves.toEqual({ kind: "result", result: "formatted" });
    expect(result.current.activeOperation).toBeNull();
  });

  it("maps the client's errors, and anything else to unavailable", async () => {
    const { result, client } = renderRunner();

    let limited: Promise<unknown> = Promise.resolve();
    act(() => {
      limited = result.current.request("run", (c) => c.run());
    });
    await act(async () => {
      client().pending[0]?.reject(new FakeServiceError("rate-limited", "Slow down"));
      await limited;
    });
    await expect(limited).resolves.toEqual({
      kind: "service-error",
      errorKind: "rate-limited",
      message: "Slow down",
    });

    let broken: Promise<unknown> = Promise.resolve();
    act(() => {
      broken = result.current.request("run", (c) => c.run());
    });
    await act(async () => {
      client().pending[1]?.reject("not an Error");
      await broken;
    });
    await expect(broken).resolves.toEqual({
      kind: "service-error",
      errorKind: "unavailable",
      message: "The run failed",
    });
  });

  it("cancel stops the client and clears the busy flag; the request reads as superseded", async () => {
    const { result, client } = renderRunner();

    let outcome: Promise<unknown> = Promise.resolve();
    act(() => {
      outcome = result.current.request("run", (c) => c.run());
    });
    await act(async () => {
      result.current.cancel();
      await outcome;
    });

    await expect(outcome).resolves.toEqual({ kind: "superseded" });
    expect(client().stopped).toBe(1);
    expect(result.current.activeOperation).toBeNull();
  });

  // PlaygroundRunnerPanel cancels from effects that depend on cancel, so a new cancel on
  // every render (the busy flag re-renders it) would stop each run as it starts.
  it("keeps cancel the same function across renders", () => {
    const { result } = renderRunner();
    const { cancel } = result.current;

    act(() => {
      void result.current.request("run", (c) => c.run());
    });

    expect(result.current.activeOperation).toBe("run");
    expect(result.current.cancel).toBe(cancel);
  });

  it("stops the client on unmount and creates it only once", async () => {
    const { result, clients, client, unmount } = renderRunner();

    act(() => {
      void result.current.request("run", (c) => c.run());
      void result.current.request("run", (c) => c.run());
    });
    unmount();

    expect(clients).toHaveLength(1);
    expect(client().stopped).toBe(1);
  });

  it("joins a Run on unchanged files instead of starting another", async () => {
    const { result, client } = renderRunner();
    const files = [{ path: "main.zig", content: "pub fn main() void {}\n" }];
    const onStart = vi.fn<() => void>();

    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.request("run", (c) => c.runAlone(), { files, onStart });
      second = result.current.request("run", (c) => c.runAlone(), {
        files: files.map((file) => ({ ...file })),
        onStart,
      });
    });
    expect(client().started).toBe(1);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(result.current.activeOperation).toBe("run");

    await act(async () => {
      client().pending[0]?.resolve("hello");
      await Promise.all([first, second]);
    });

    // The repeat reports the outcome of the run it joined; the first caller renders nothing.
    await expect(second).resolves.toEqual({ kind: "result", result: "hello" });
    await expect(first).resolves.toEqual({ kind: "superseded" });
    expect(client().stopped).toBe(0);
    expect(result.current.activeOperation).toBeNull();
  });

  it("replaces a Run whose files changed", async () => {
    const { result, client } = renderRunner();
    const onStart = vi.fn<() => void>();

    let first: Promise<unknown> = Promise.resolve();
    let second: Promise<unknown> = Promise.resolve();
    act(() => {
      first = result.current.request("run", (c) => c.runAlone(), {
        files: [{ path: "main.zig", content: "old\n" }],
        onStart,
      });
      second = result.current.request("run", (c) => c.runAlone(), {
        files: [{ path: "main.zig", content: "new\n" }],
        onStart,
      });
    });
    expect(client().started).toBe(2);
    expect(onStart).toHaveBeenCalledTimes(2);
    await act(async () => {
      await first;
    });
    await expect(first).resolves.toEqual({ kind: "superseded" });

    await act(async () => {
      client().pending[0]?.resolve("new output");
      await second;
    });
    await expect(second).resolves.toEqual({ kind: "result", result: "new output" });
    expect(result.current.activeOperation).toBeNull();
  });

  it("starts a new Run on unchanged files once the last one finished", async () => {
    const { result, client } = renderRunner();
    const files = [{ path: "main.zig", content: "pub fn main() void {}\n" }];

    for (const output of ["first", "second"]) {
      let outcome: Promise<unknown> = Promise.resolve();
      act(() => {
        outcome = result.current.request("run", (c) => c.runAlone(), { files });
      });
      await act(async () => {
        client().pending[0]?.resolve(output);
        await outcome;
      });
      await expect(outcome).resolves.toEqual({ kind: "result", result: output });
    }

    expect(client().started).toBe(2);
  });

  // An in-page run that is stopped is abandoned rather than rejected, so it may never settle.
  it("lets nothing join a Run that cancel stopped", async () => {
    const { result } = renderRunner();
    const files = [{ path: "main.asm", content: "ret\n" }];
    const execute = vi.fn<(client: FakeClient) => Promise<string>>(
      () => new Promise<string>(() => {}),
    );

    act(() => {
      void result.current.request("run", execute, { files });
    });
    act(() => result.current.cancel());
    act(() => {
      void result.current.request("run", execute, { files });
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.current.activeOperation).toBe("run");
  });

  it("never joins a request that named no files, or another operation", () => {
    const { result, client } = renderRunner();
    const files = [{ path: "main.go", content: "package main\n" }];

    act(() => {
      void result.current.request("format", (c) => c.run());
      void result.current.request("format", (c) => c.run());
      void result.current.request("format", (c) => c.run(), { files });
      void result.current.request("run", (c) => c.run(), { files });
    });

    expect(client().started).toBe(4);
  });

  it("creates no client until the first request", () => {
    const { clients, unmount } = renderRunner();
    unmount();
    expect(clients).toHaveLength(0);
  });
});
