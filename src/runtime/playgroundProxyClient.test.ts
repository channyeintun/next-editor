import { describe, expect, it } from "vite-plus/test";
import { errorKindForStatus } from "./playgroundProxyClient";

describe("errorKindForStatus", () => {
  it.each([
    [503, "disabled"],
    [429, "rate-limited"],
    [504, "timeout"],
    [400, "invalid-source"],
    [413, "invalid-source"],
    [422, "invalid-source"],
    [500, "unavailable"],
    [502, "unavailable"],
    [404, "unavailable"],
  ] as const)("reads HTTP %i as %s", (status, kind) => {
    expect(errorKindForStatus(status)).toBe(kind);
  });
});
