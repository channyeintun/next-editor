import { fireEvent, render, screen } from "@testing-library/react";
import { Video, VideoOff } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import RecordingOptionToggle from "./RecordingOptionToggle";

const renderToggle = (on: boolean) => {
  const onToggle = vi.fn<() => void>();
  render(
    <RecordingOptionToggle
      tour="camera"
      label="Camera"
      on={on}
      onToggle={onToggle}
      icon={{ on: Video, off: VideoOff }}
      title={{ on: "Record camera", off: "Do not record camera" }}
    />,
  );
  return { button: screen.getByRole("button", { name: "Camera" }), onToggle };
};

describe("RecordingOptionToggle", () => {
  it("shows an option that is on as pressed, with its on icon and title", () => {
    const { button } = renderToggle(true);

    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("title", "Record camera");
    expect(button).toHaveAttribute("data-tour", "camera");
    expect(button).toHaveClass("border-pinata-cyan", "bg-pinata-cyan", "text-slate-950");
    expect(button.querySelector(".lucide-video")).not.toBeNull();
    expect(button.querySelector(".lucide-video-off")).toBeNull();
  });

  it("shows an option that is off as not pressed, with its off icon and title", () => {
    const { button } = renderToggle(false);

    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("title", "Do not record camera");
    expect(button).toHaveClass("border-slate-700", "text-slate-400");
    expect(button.querySelector(".lucide-video-off")).not.toBeNull();
  });

  it("asks to switch the option when pressed", () => {
    const { button, onToggle } = renderToggle(false);

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
