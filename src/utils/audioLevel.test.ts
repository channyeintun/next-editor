import { describe, expect, it } from "vite-plus/test";
import { LevelMonitor, measureLevel, meterFraction, METER_FLOOR_DB } from "./audioLevel";

const sine = (amplitude: number, length = 4800) =>
  Float32Array.from({ length }, (_, index) => amplitude * Math.sin((2 * Math.PI * index) / 48));

const reading = (rmsDb: number, peakDb = rmsDb + 3) => ({ rmsDb, peakDb });

describe("measureLevel", () => {
  it("reads a full-scale sine as -3 dBFS RMS and 0 dBFS peak", () => {
    const level = measureLevel(sine(1));
    expect(level.rmsDb).toBeCloseTo(-3.01, 2);
    expect(level.peakDb).toBeCloseTo(0, 2);
  });

  it("reads each halving of amplitude as 6 dB quieter", () => {
    expect(measureLevel(sine(0.5)).rmsDb - measureLevel(sine(1)).rmsDb).toBeCloseTo(-6.02, 2);
  });

  it("reads silence as minus infinity", () => {
    expect(measureLevel(new Float32Array(128))).toEqual({ rmsDb: -Infinity, peakDb: -Infinity });
  });
});

describe("meterFraction", () => {
  it("runs from empty at the floor to full at full scale", () => {
    expect(meterFraction(-Infinity)).toBe(0);
    expect(meterFraction(METER_FLOOR_DB)).toBe(0);
    expect(meterFraction(METER_FLOOR_DB / 2)).toBeCloseTo(0.5);
    expect(meterFraction(0)).toBe(1);
    expect(meterFraction(6)).toBe(1);
  });
});

describe("LevelMonitor", () => {
  it("is still listening before any reading, and through a short silence", () => {
    const monitor = new LevelMonitor(3_000);
    expect(monitor.verdict(0)).toBe("listening");
    monitor.add(reading(-Infinity), 0);
    monitor.add(reading(-Infinity), 1_000);
    expect(monitor.verdict(1_000)).toBe("listening");
  });

  it("calls a whole window of silence silent", () => {
    const monitor = new LevelMonitor(3_000);
    for (let at = 0; at <= 3_000; at += 500) monitor.add(reading(-95), at);
    expect(monitor.verdict(3_000)).toBe("silent");
    expect(monitor.heardSpeech).toBe(false);
  });

  it("tells room sound from quiet speech from a good level", () => {
    const monitor = new LevelMonitor(3_000);
    monitor.add(reading(-60), 0);
    expect(monitor.verdict(0)).toBe("waiting");
    monitor.add(reading(-40), 100);
    expect(monitor.verdict(100)).toBe("quiet");
    monitor.add(reading(-20), 200);
    expect(monitor.verdict(200)).toBe("good");
    expect(monitor.heardSpeech).toBe(true);
  });

  it("warns about clipping peaks", () => {
    const monitor = new LevelMonitor(3_000);
    monitor.add(reading(-12, -0.2), 0);
    expect(monitor.verdict(0)).toBe("loud");
  });

  it("judges only the last window: loud speech that has passed no longer counts", () => {
    const monitor = new LevelMonitor(3_000);
    monitor.add(reading(-12, -0.2), 0);
    monitor.add(reading(-60), 3_500);
    expect(monitor.verdict(3_500)).toBe("waiting");
    // Speech once heard stays heard.
    expect(monitor.heardSpeech).toBe(true);
    expect(monitor.listenedMs(3_500)).toBe(3_500);
  });
});
