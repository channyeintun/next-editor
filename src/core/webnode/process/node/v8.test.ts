// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Buffer } from "./buffer";
import v8 from "./v8";

const roundTrip = (value: unknown) => v8.deserialize(v8.serialize(value));

describe("v8.serialize / deserialize", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["true", true],
    ["false", false],
    ["number", 3.25],
    ["NaN", Number.NaN],
    ["-0", -0],
    ["Infinity", -Infinity],
    ["bigint", -(2n ** 100n) + 7n],
    ["string", "héllo \u{1F600}"],
    ["empty string", ""],
  ])("round-trips %s", (_label, value) => {
    expect(Object.is(roundTrip(value), value)).toBe(true);
  });

  it("round-trips structured values", () => {
    const value = {
      date: new Date(1234567890),
      regexp: /a+b/giu,
      map: new Map<unknown, unknown>([
        [1, "one"],
        [{ k: 1 }, [2]],
      ]),
      set: new Set([1, "two", null]),
      nested: { a: [1, { b: 2 }] },
      boxed: [Object(5), Object("s"), Object(true)],
    };
    expect(roundTrip(value)).toEqual(value);
  });

  it("keeps array holes and extra array properties", () => {
    const array: unknown[] = [1];
    array[2] = 3;
    (array as unknown as { extra: string }).extra = "x";
    const back = roundTrip(array) as unknown[];
    expect(back.length).toBe(3);
    expect(1 in back).toBe(false);
    expect((back as unknown as { extra: string }).extra).toBe("x");
  });

  it("round-trips binary data with its type", () => {
    const buffer = new ArrayBuffer(4);
    new Uint8Array(buffer).set([1, 2, 3, 4]);
    const back = roundTrip({
      buffer,
      u8: new Uint8Array([9, 8]),
      f64: new Float64Array([1.5, -2]),
      i64: new BigInt64Array([-5n]),
      view: new DataView(new Uint8Array([7, 7]).buffer),
      node: Buffer.from("hi"),
    }) as Record<string, unknown>;
    expect(new Uint8Array(back.buffer as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(back.u8).toBeInstanceOf(Uint8Array);
    expect([...(back.u8 as Uint8Array)]).toEqual([9, 8]);
    expect([...(back.f64 as Float64Array)]).toEqual([1.5, -2]);
    expect([...(back.i64 as BigInt64Array)]).toEqual([-5n]);
    expect((back.view as DataView).getUint8(1)).toBe(7);
    expect(Buffer.isBuffer(back.node)).toBe(true);
    expect((back.node as Buffer).toString()).toBe("hi");
  });

  it("round-trips errors with their type, message, stack and cause", () => {
    const error = new TypeError("bad", { cause: "why" });
    const back = roundTrip(error) as TypeError;
    expect(back).toBeInstanceOf(TypeError);
    expect(back.message).toBe("bad");
    expect(back.stack).toBe(error.stack);
    expect(back.cause).toBe("why");
  });

  it("keeps shared and circular references", () => {
    const shared = { s: 1 };
    const value: Record<string, unknown> = { a: shared, b: shared };
    value.self = value;
    const back = roundTrip(value) as Record<string, unknown>;
    expect(back.a).toBe(back.b);
    expect(back.self).toBe(back);
  });

  it("refuses what cannot be cloned, as Node does", () => {
    expect(() => v8.serialize(() => 1)).toThrow("could not be cloned.");
    expect(() => v8.serialize(Symbol("x"))).toThrow("could not be cloned.");
    expect(() => v8.deserialize(Buffer.from([1, 2, 3]))).toThrow("Unable to deserialize");
  });

  it("returns a Buffer", () => {
    expect(Buffer.isBuffer(v8.serialize(1))).toBe(true);
  });
});

describe("v8 heap and engine members", () => {
  it("reports heap statistics with Node's keys", async () => {
    const real = (await import("node:v8")).getHeapStatistics();
    const ours = v8.getHeapStatistics();
    for (const key of Object.keys(ours)) {
      expect(real).toHaveProperty(key);
      expect(typeof ours[key]).toBe("number");
    }
    expect(Object.keys(v8.getHeapCodeStatistics()).sort()).toEqual(
      Object.keys((await import("node:v8")).getHeapCodeStatistics()).sort(),
    );
    expect(v8.getHeapSpaceStatistics()).toEqual([]);
  });

  it("has the inert and advisory members", () => {
    expect(() => v8.setFlagsFromString("--harmony")).not.toThrow();
    expect(() => v8.setFlagsFromString(1 as never)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
    expect(Number.isInteger(v8.cachedDataVersionTag())).toBe(true);
    expect(v8.startupSnapshot.isBuildingSnapshot()).toBe(false);
    expect(v8.isStringOneByteRepresentation("abcÿ")).toBe(true);
    expect(v8.isStringOneByteRepresentation("Ā")).toBe(false);
    expect(typeof v8.promiseHooks.onInit(() => {})).toBe("function");
    v8.takeCoverage();
    v8.stopCoverage();
  });

  it("throws named errors for what the browser lacks", () => {
    expect(() => v8.getHeapSnapshot()).toThrow("v8.getHeapSnapshot is not available in webnode");
    expect(() => v8.writeHeapSnapshot()).toThrow("not available in webnode");
    expect(() => new v8.Serializer()).toThrow("v8.Serializer is not available in webnode");
    expect(() => new v8.DefaultDeserializer()).toThrow("not available in webnode");
  });
});
