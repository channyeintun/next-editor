import { describe, expect, it } from "vite-plus/test";
import {
  estimateNarrationMsForRenderWait,
  parseRuntimeModeParam,
  shouldAutostartRender,
  studioRenderWaitMs,
} from "./renderLaunch";

describe("shouldAutostartRender", () => {
  it("honours autostart=1 only in an automation-controlled browser", () => {
    expect(shouldAutostartRender("1", true)).toBe(true);
    // A crafted link opened in a normal browser waits for the click.
    expect(shouldAutostartRender("1", false)).toBe(false);
  });

  it("ignores a missing or other autostart value", () => {
    expect(shouldAutostartRender(null, true)).toBe(false);
    expect(shouldAutostartRender("true", true)).toBe(false);
  });
});

describe("studioRenderWaitMs", () => {
  it("keeps the fixed budget for a lesson with no narration estimate", () => {
    expect(studioRenderWaitMs(0)).toBe(420_000);
  });

  it("grows with the narration so a long crash course can finish", () => {
    const twentyNineMinutes = 29 * 60_000;
    // The narration alone plays in real time, so the wait must exceed it.
    expect(studioRenderWaitMs(twentyNineMinutes)).toBe(420_000 + 2 * twentyNineMinutes);
    expect(studioRenderWaitMs(twentyNineMinutes)).toBeGreaterThan(twentyNineMinutes);
  });

  it("estimates the narration it waits for at 140 words a minute", () => {
    expect(estimateNarrationMsForRenderWait(0)).toBe(0);
    expect(estimateNarrationMsForRenderWait(140)).toBe(60_000);
    expect(estimateNarrationMsForRenderWait(-5)).toBe(0);
  });
});

describe("parseRuntimeModeParam (STUDIO-05)", () => {
  it("accepts both documented values", () => {
    expect(parseRuntimeModeParam("live")).toEqual({ mode: "live", invalid: false, raw: "live" });
    expect(parseRuntimeModeParam("fixture")).toEqual({
      mode: "fixture",
      invalid: false,
      raw: "fixture",
    });
  });

  it("treats a missing or empty param as no request (use the plan default)", () => {
    expect(parseRuntimeModeParam(null)).toEqual({ mode: null, invalid: false, raw: null });
    expect(parseRuntimeModeParam("")).toEqual({ mode: null, invalid: false, raw: "" });
  });

  it("flags an unrecognized value as invalid instead of silently defaulting", () => {
    // The bug: `fixture` (and everything but `live`) used to collapse to null and
    // silently fall back to the plan default — a live-default plan would then
    // contact the real service even though fixture was requested.
    expect(parseRuntimeModeParam("staging")).toEqual({
      mode: null,
      invalid: true,
      raw: "staging",
    });
    expect(parseRuntimeModeParam("Live").invalid).toBe(true);
    expect(parseRuntimeModeParam("FIXTURE").invalid).toBe(true);
  });
});
