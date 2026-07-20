import { describe, expect, it } from "vite-plus/test";
import { StudioActionError, abortableSleep, resolveAnchorOffset, waitUntil } from "./async";

describe("resolveAnchorOffset", () => {
  const content = "aaa bbb aaa bbb aaa";

  it("anchors the start of the file for an empty `after`", () => {
    expect(resolveAnchorOffset(content, { after: "", occurrence: 1 })).toBe(0);
  });

  it("resolves the requested occurrence's end", () => {
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 1 })).toBe(3);
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 2 })).toBe(11);
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 3 })).toBe(19);
  });

  it("returns null for a missing occurrence instead of guessing", () => {
    expect(resolveAnchorOffset(content, { after: "aaa", occurrence: 4 })).toBeNull();
    expect(resolveAnchorOffset(content, { after: "zzz", occurrence: 1 })).toBeNull();
  });

  it("handles overlapping candidates by scanning forward", () => {
    expect(resolveAnchorOffset("aaaa", { after: "aa", occurrence: 2 })).toBe(3);
  });
});

describe("waitUntil", () => {
  it("resolves once the predicate flips", async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 30);
    await waitUntil(() => flag, {
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      description: "the flag",
      intervalMs: 5,
    });
    expect(flag).toBe(true);
  });

  it("rejects with the description after the timeout", async () => {
    await expect(
      waitUntil(() => false, {
        timeoutMs: 40,
        signal: new AbortController().signal,
        description: "something that never happens",
        intervalMs: 5,
      }),
    ).rejects.toThrow(/something that never happens/);
  });

  it("rejects when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(
      waitUntil(() => false, {
        timeoutMs: 5_000,
        signal: controller.signal,
        description: "an aborted wait",
        intervalMs: 5,
      }),
    ).rejects.toThrow(StudioActionError);
  });

  it("propagates predicate throws as failures", async () => {
    await expect(
      waitUntil(
        () => {
          throw new StudioActionError("hard failure");
        },
        {
          timeoutMs: 1_000,
          signal: new AbortController().signal,
          description: "a throwing predicate",
        },
      ),
    ).rejects.toThrow(/hard failure/);
  });
});

describe("abortableSleep", () => {
  it("sleeps approximately the requested time", async () => {
    const start = performance.now();
    await abortableSleep(25, new AbortController().signal);
    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
  });

  it("rejects immediately when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(1_000, controller.signal)).rejects.toThrow(StudioActionError);
  });
});
