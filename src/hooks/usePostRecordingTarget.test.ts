import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Recording } from "../core/src";
import { usePostRecordingTarget } from "./usePostRecordingTarget";

function createRecording(id: string): Recording {
  return {
    version: 4,
    id,
    name: "Test recording",
    createdAt: 1_700_000_000_000,
    duration: 1000,
    keyframeInterval: 120,
    frames: [],
  };
}

describe("usePostRecordingTarget", () => {
  it("fires once currentRecording appears on a LATER render than the isRecording(false) edge", () => {
    // Reproduces editorMachine's real sequence for a mic/camera stop: the
    // machine passes through an intermediate "stoppingRecording" state where
    // isRecording is already false but context.recording isn't finalized
    // until a later transition (up to ~2s later) — see editorMachine.ts.
    const recording = createRecording("rec-1");
    const { result, rerender } = renderHook(
      ({ isRecording, currentRecording }) => usePostRecordingTarget(isRecording, currentRecording),
      { initialProps: { isRecording: true, currentRecording: null as Recording | null } },
    );
    expect(result.current.target).toBeNull();

    // isRecording flips false, but the recording isn't populated yet.
    rerender({ isRecording: false, currentRecording: null });
    expect(result.current.target).toBeNull();

    // Some time later, finalizeRecording runs and populates context.recording
    // while isRecording is still false.
    rerender({ isRecording: false, currentRecording: recording });
    expect(result.current.target).toBe(recording);
  });

  it("never fires for a recording loaded via URL/import (isRecording never true)", () => {
    const recording = createRecording("rec-2");
    const { result, rerender } = renderHook(
      ({ isRecording, currentRecording }) => usePostRecordingTarget(isRecording, currentRecording),
      { initialProps: { isRecording: false, currentRecording: null as Recording | null } },
    );

    rerender({ isRecording: false, currentRecording: recording });
    expect(result.current.target).toBeNull();
  });

  it("fires again for a second, different recording after the first is cleared", () => {
    const first = createRecording("rec-3");
    const second = createRecording("rec-4");
    const { result, rerender } = renderHook(
      ({ isRecording, currentRecording }) => usePostRecordingTarget(isRecording, currentRecording),
      { initialProps: { isRecording: true, currentRecording: null as Recording | null } },
    );

    rerender({ isRecording: false, currentRecording: first });
    expect(result.current.target).toBe(first);

    result.current.clear();
    rerender({ isRecording: true, currentRecording: first });
    rerender({ isRecording: false, currentRecording: second });
    expect(result.current.target).toBe(second);
  });

  it("does not re-fire for the same recording id once already shown", () => {
    const recording = createRecording("rec-5");
    const { result, rerender } = renderHook(
      ({ isRecording, currentRecording }) => usePostRecordingTarget(isRecording, currentRecording),
      { initialProps: { isRecording: true, currentRecording: null as Recording | null } },
    );

    rerender({ isRecording: false, currentRecording: recording });
    expect(result.current.target).toBe(recording);

    result.current.clear();
    // Same recording still in context, no new recording session — shouldn't
    // resurrect the modal after the user already dismissed it.
    rerender({ isRecording: false, currentRecording: recording });
    expect(result.current.target).toBeNull();
  });
});
