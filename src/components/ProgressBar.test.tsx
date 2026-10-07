import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import { LIVE_PROGRESS_VARIABLE, ProgressBar } from "./ProgressBar";

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

  // The player moves the fill and thumb every tick through the variable, without
  // re-rendering the bar; a drag shows the pointer's position instead.
  it("places the fill and thumb by the live variable, and by the pointer while dragging", () => {
    const { container } = render(
      <ProgressBar progress={25} duration={60_000} currentTime={15_000} onSeek={() => {}} />,
    );
    const bar = screen.getByRole("progressbar");
    const fill = container.querySelector<HTMLElement>(".next-editor-progress-bar");
    const thumb = container.querySelector<HTMLElement>(".next-editor-progress-thumb");

    expect(fill?.style.width).toBe(`var(${LIVE_PROGRESS_VARIABLE}, 25%)`);
    expect(thumb?.style.left).toBe(`var(${LIVE_PROGRESS_VARIABLE}, 25%)`);

    bar.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    fireEvent.mouseDown(bar, { clientX: 100 });
    expect(fill?.style.width).toBe("50%");
    expect(thumb?.style.left).toBe("50%");
  });
});
