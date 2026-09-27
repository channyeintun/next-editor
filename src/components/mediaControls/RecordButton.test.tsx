import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import RecordButton from "./RecordButton";

const renderButton = (props: Partial<Parameters<typeof RecordButton>[0]> = {}) => {
  const onClick = vi.fn<() => void>();
  render(
    <RecordButton
      isRecording={false}
      isRecordingPaused={false}
      hasRecording={false}
      disabled={false}
      iconSize={14}
      plusSize={10}
      onClick={onClick}
      {...props}
    />,
  );
  return { button: screen.getByRole("button"), onClick };
};

describe("RecordButton", () => {
  it("starts a take when nothing is loaded", () => {
    const { button, onClick } = renderButton();

    expect(button).toHaveAttribute("title", "Start Recording");
    expect(button).toHaveAttribute("data-tour", "record");
    expect(button.querySelector(".lucide-square, .lucide-circle")).toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stops the running take, pulsing until it is paused", () => {
    const { button } = renderButton({ isRecording: true, hasRecording: true });

    expect(button).toHaveAttribute("title", "Stop Recording");
    expect(button.querySelector(".lucide-square")).toHaveClass("animate-pulse");
  });

  it("stops pulsing while the take is paused", () => {
    const { button } = renderButton({ isRecording: true, isRecordingPaused: true });

    expect(button.querySelector(".lucide-square")).not.toHaveClass("animate-pulse");
  });

  it("offers a new take once one is loaded", () => {
    const { button } = renderButton({ hasRecording: true });

    expect(button).toHaveAttribute("title", "New Recording");
    expect(button.querySelector(".lucide-circle")).not.toBeNull();
    expect(button.querySelector(".lucide-plus")).not.toBeNull();
  });

  it("is dimmed and disabled while the lesson plays", () => {
    const { button, onClick } = renderButton({ hasRecording: true, disabled: true });

    expect(button).toBeDisabled();
    expect(button).toHaveClass("opacity-50", "cursor-not-allowed");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
