// @vitest-environment node
// util.inspect loads the package it is made of with its first use, so a
// process that never inspects (a shell) does not evaluate it at its start.
import { describe, expect, it, vi } from "vitest";

const descriptor = (target: object, key: string) => {
  const found = Object.getOwnPropertyDescriptor(target, key)!;
  return "value" in found
    ? {
        data: true,
        writable: found.writable,
        enumerable: found.enumerable,
        configurable: found.configurable,
      }
    : { data: false, enumerable: found.enumerable, configurable: found.configurable };
};

describe("util.inspect", () => {
  it("leaves the package unloaded until its first use, then has Node's members", async () => {
    vi.resetModules();
    const { inspect, format, stripVTControlCharacters } = await import("./inspect");
    // Not loaded: the package's objects are not there yet.
    expect(descriptor(inspect, "colors").data).toBe(false);
    expect(descriptor(inspect, "styles").data).toBe(false);
    expect(inspect({ a: [1] })).toBe("{ a: [ 1 ] }");
    // Real Node v26 and v22: each member as `Object.getOwnPropertyDescriptor` shows it.
    const data = { data: true, writable: true, enumerable: true, configurable: true };
    expect(descriptor(inspect, "colors")).toEqual(data);
    expect(descriptor(inspect, "styles")).toEqual(data);
    expect(descriptor(inspect, "custom")).toEqual(data);
    expect(descriptor(inspect, "defaultOptions")).toEqual({
      data: false,
      enumerable: false,
      configurable: false,
    });
    expect(Object.keys(inspect)).toEqual(["custom", "colors", "styles"]);
    expect([inspect.name, inspect.length, format.name, format.length]).toEqual([
      "inspect",
      2,
      "format",
      0,
    ]);
    expect([
      stripVTControlCharacters.name,
      stripVTControlCharacters("\u001b[31mx\u001b[0m"),
    ]).toEqual(["stripVTControlCharacters", "x"]);
    expect((inspect.colors as Record<string, unknown>).grey).toEqual([90, 39]);
  });

  it("loads the package for a style set before any use, which then prints with it", async () => {
    vi.resetModules();
    const { inspect } = await import("./inspect");
    inspect.styles.number = "red";
    expect(inspect(5, { colors: true })).toBe("\u001b[31m5\u001b[39m");
  });
});
