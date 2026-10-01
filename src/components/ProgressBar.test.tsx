import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("reports the position in whole seconds, read out as times", () => {
    render(<ProgressBar progress={25} duration={296_400} currentTime={83_900} />);
    const bar = screen.getByRole("progressbar", { name: "Playback progress" });

    expect(bar).toHaveAttribute("aria-valuenow", "83");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "296");
    expect(bar).toHaveAttribute("aria-valuetext", "1:23 of 4:56");
  });

  it("never reports a position past the end", () => {
    render(<ProgressBar progress={100} duration={60_000} currentTime={60_450} />);
    const bar = screen.getByRole("progressbar");

    expect(bar).toHaveAttribute("aria-valuenow", "60");
    expect(bar).toHaveAttribute("aria-valuetext", "1:00 of 1:00");
  });
});
