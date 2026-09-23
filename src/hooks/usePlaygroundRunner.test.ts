import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type PlaygroundClientBinding, usePlaygroundRunner } from "./usePlaygroundRunner";

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

  run(): Promise<string> {
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
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

  it("creates no client until the first request", () => {
    const { clients, unmount } = renderRunner();
    unmount();
    expect(clients).toHaveLength(0);
  });
});
