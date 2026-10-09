import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { LIVE_PROGRESS_VARIABLE, ProgressBar } from "./ProgressBar";

describe("ProgressBar", () => {
  it("reports the position in whole seconds, read out as times", () => {
    render(<ProgressBar progress={25} duration={296_400} currentTime={83_900} />);
    // Without onSeek the bar only reports, so it is no tab stop.
    const bar = screen.getByRole("progressbar", { name: "Playback progress" });
    expect(bar).not.toHaveAttribute("tabindex");

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
    const bar = screen.getByRole("slider", { name: "Playback progress" });
    const fill = container.querySelector<HTMLElement>(".next-editor-progress-bar");
    const thumb = container.querySelector<HTMLElement>(".next-editor-progress-thumb");

    expect(fill?.style.width).toBe(`var(${LIVE_PROGRESS_VARIABLE}, 25%)`);
    expect(thumb?.style.left).toBe(`var(${LIVE_PROGRESS_VARIABLE}, 25%)`);

    bar.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;
    fireEvent.mouseDown(bar, { clientX: 100 });
    expect(fill?.style.width).toBe("50%");
    expect(thumb?.style.left).toBe("50%");
  });

  // The click that ends a press on the bar must not seek a second time: every seek
  // resyncs every track.
  it("seeks once for a press and release on the bar", () => {
    const onSeek = vi.fn<(time: number) => void>();
    render(<ProgressBar progress={0} duration={60_000} currentTime={0} onSeek={onSeek} />);
    const bar = screen.getByRole("slider");
    bar.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;

    fireEvent.mouseDown(bar, { clientX: 100 });
    fireEvent.mouseUp(document, { clientX: 100 });
    fireEvent.click(bar, { clientX: 100 });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(30_000);
  });

  it("seeks once for a click with no press before it", () => {
    const onSeek = vi.fn<(time: number) => void>();
    render(<ProgressBar progress={0} duration={60_000} currentTime={0} onSeek={onSeek} />);
    const bar = screen.getByRole("slider");
    bar.getBoundingClientRect = () => ({ left: 0, width: 200 }) as DOMRect;

    fireEvent.click(bar, { clientX: 50 });

    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(15_000);
  });

  it("is a slider a keyboard reaches and seeks with when it can seek", () => {
    const onSeek = vi.fn<(time: number) => void>();
    render(<ProgressBar progress={25} duration={60_000} currentTime={15_000} onSeek={onSeek} />);
    const bar = screen.getByRole("slider", { name: "Playback progress" });

    bar.focus();
    expect(bar).toHaveFocus();
    expect(bar).toHaveAttribute("aria-valuenow", "15");
    expect(bar).toHaveAttribute("aria-valuetext", "0:15 of 1:00");

    const seekFor = (key: string) => {
      onSeek.mockClear();
      // fireEvent returns false once a handler has called preventDefault.
      expect(fireEvent.keyDown(bar, { key })).toBe(false);
      expect(onSeek).toHaveBeenCalledTimes(1);
      return onSeek.mock.calls[0][0];
    };
    expect(seekFor("ArrowRight")).toBe(20_000);
    expect(seekFor("ArrowUp")).toBe(20_000);
    expect(seekFor("ArrowLeft")).toBe(10_000);
    expect(seekFor("ArrowDown")).toBe(10_000);
    expect(seekFor("PageUp")).toBe(25_000);
    expect(seekFor("PageDown")).toBe(5_000);
    expect(seekFor("Home")).toBe(0);
    expect(seekFor("End")).toBe(60_000);
  });

  it("keeps keyboard seeks within the lesson", () => {
    const onSeek = vi.fn<(time: number) => void>();
    const { rerender } = render(
      <ProgressBar progress={95} duration={60_000} currentTime={57_000} onSeek={onSeek} />,
    );
    const bar = screen.getByRole("slider");

    fireEvent.keyDown(bar, { key: "PageUp" });
    expect(onSeek).toHaveBeenLastCalledWith(60_000);

    rerender(<ProgressBar progress={5} duration={60_000} currentTime={3_000} onSeek={onSeek} />);
    fireEvent.keyDown(bar, { key: "ArrowLeft" });
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it("leaves other keys, and keys with a modifier, to the page", () => {
    const onSeek = vi.fn<(time: number) => void>();
    render(<ProgressBar progress={25} duration={60_000} currentTime={15_000} onSeek={onSeek} />);
    const bar = screen.getByRole("slider");

    expect(fireEvent.keyDown(bar, { key: "k" })).toBe(true);
    expect(fireEvent.keyDown(bar, { key: "Enter" })).toBe(true);
    expect(fireEvent.keyDown(bar, { key: "ArrowLeft", altKey: true })).toBe(true);
    expect(fireEvent.keyDown(bar, { key: "ArrowRight", metaKey: true })).toBe(true);
    expect(onSeek).not.toHaveBeenCalled();
  });

  it("stays a read-only progressbar until there is a length to seek in", () => {
    render(<ProgressBar progress={0} duration={0} currentTime={0} onSeek={() => {}} />);

    expect(screen.getByRole("progressbar")).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  });
});
