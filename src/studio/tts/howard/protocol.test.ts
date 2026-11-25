import { describe, expect, it } from "vite-plus/test";
import {
  HOWARD_DEFAULT_SERVER_URL,
  howardFrameCapOf,
  howardServerUrlOf,
  howardTakeHitFrameCap,
  isHowardReferenceReady,
} from "./protocol";

const SAMPLES_PER_FRAME = 1_920;

describe("howardServerUrlOf", () => {
  it("accepts a loopback address and returns its origin", () => {
    expect(howardServerUrlOf(" http://127.0.0.1:8080/ ")).toEqual({
      ok: true,
      url: HOWARD_DEFAULT_SERVER_URL,
    });
    expect(howardServerUrlOf("http://localhost:9000")).toEqual({
      ok: true,
      url: "http://localhost:9000",
    });
    expect(howardServerUrlOf("http://[::1]:8080")).toEqual({ ok: true, url: "http://[::1]:8080" });
  });

  it("refuses an address that is not on this computer", () => {
    expect(
      [
        "http://192.168.1.20:8080",
        "http://example.com:8080",
        "https://127.0.0.1:8080",
        "http://127.0.0.1.example.com:8080",
      ].filter((address) => howardServerUrlOf(address).ok),
    ).toEqual([]);
  });

  it("refuses a path, a query or credentials", () => {
    expect(
      [
        "http://127.0.0.1:8080/v1",
        "http://127.0.0.1:8080/?a=1",
        "http://user:secret@127.0.0.1:8080",
      ].filter((address) => howardServerUrlOf(address).ok),
    ).toEqual([]);
  });

  it("refuses text that is not an address", () => {
    expect(howardServerUrlOf("8080")).toMatchObject({ ok: false });
    expect(howardServerUrlOf("")).toMatchObject({ ok: false });
  });
});

describe("howardFrameCapOf", () => {
  it("gives a short dialog ten seconds plus three frames a character", () => {
    expect(howardFrameCapOf("")).toBe(125);
    expect(howardFrameCapOf("a".repeat(100))).toBe(425);
  });

  it("counts the trimmed text", () => {
    expect(howardFrameCapOf(`  ${"a".repeat(100)}\n`)).toBe(425);
  });

  it("never passes the engine's own ceiling", () => {
    expect(howardFrameCapOf("a".repeat(2_000))).toBe(2_048);
  });
});

describe("howardTakeHitFrameCap", () => {
  it("flags a take as long as its cap, and one frame short of it", () => {
    expect(howardTakeHitFrameCap(425 * SAMPLES_PER_FRAME, 425)).toBe(true);
    expect(howardTakeHitFrameCap(424 * SAMPLES_PER_FRAME, 425)).toBe(true);
  });

  it("does not flag a take the model ended itself", () => {
    expect(howardTakeHitFrameCap(423 * SAMPLES_PER_FRAME, 425)).toBe(false);
    expect(howardTakeHitFrameCap(90 * SAMPLES_PER_FRAME, 425)).toBe(false);
  });
});

describe("isHowardReferenceReady", () => {
  const reference = (seconds: number) => ({
    samples: new Float32Array(Math.round(seconds * 24_000)),
    sampleRate: 24_000,
  });

  it("accepts 3 s up to the stored-sample limit, inclusive", () => {
    expect(isHowardReferenceReady(reference(2.9), 20)).toBe(false);
    expect(isHowardReferenceReady(reference(3), 20)).toBe(true);
    expect(isHowardReferenceReady(reference(20), 20)).toBe(true);
    expect(isHowardReferenceReady(reference(20.1), 20)).toBe(false);
  });
});
