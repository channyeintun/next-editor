import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import HoverRing from "./HoverRing";

const ring = (button: HTMLElement) => button.querySelector<SVGRectElement>(".hover-ring rect")!;

describe("HoverRing", () => {
  let reducedMotion = true;

  beforeEach(() => {
    reducedMotion = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: reducedMotion && query.includes("reduce") })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is hidden from assistive technology and leaves the control's name alone", () => {
    render(
      <button type="button">
        Settings
        <HoverRing />
      </button>,
    );

    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.querySelector(".hover-ring")).toHaveAttribute("aria-hidden", "true");
  });

  it("draws the whole ring while a mouse is over the control and none once it leaves", () => {
    render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(ring(button).style.strokeDasharray).toBe("100 0");
    expect(ring(button).style.opacity).toBe("1");

    fireEvent.pointerLeave(button, { pointerType: "mouse" });
    expect(ring(button).style.strokeDasharray).toBe("0 100");
    expect(ring(button).style.opacity).toBe("0");
  });

  it("animates the ring in over frames when motion is allowed", () => {
    reducedMotion = false;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => frames.push(callback)),
    );
    render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(frames).toHaveLength(1);
    frames.shift()!(16);
    const partway = Number.parseFloat(ring(button).style.strokeDasharray);
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(100);
    expect(frames).toHaveLength(1);
  });

  it("ignores a touch, which has no hover", () => {
    render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "touch" });
    expect(ring(button).style.strokeDasharray).toBe("");
  });

  it("stays off a disabled control", () => {
    render(
      <button type="button" disabled>
        Record
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(ring(button).style.strokeDasharray).toBe("");
  });

  it("keeps a mouse's ring when a touch leaves the control", () => {
    render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.pointerLeave(button, { pointerType: "touch" });
    expect(ring(button).style.strokeDasharray).toBe("100 0");
  });

  it("lets go once the pointer is over something else, even with no pointerleave", () => {
    render(
      <>
        <button type="button">
          Move down
          <HoverRing />
        </button>
        <p>Elsewhere</p>
      </>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    fireEvent.pointerOver(button.querySelector(".hover-ring")!.parentElement!, {
      pointerType: "mouse",
    });
    expect(ring(button).style.strokeDasharray).toBe("100 0");

    // A keyed reorder moved the hovered node: no pointerleave, only the next pointerover.
    fireEvent.pointerOver(screen.getByText("Elsewhere"), { pointerType: "mouse" });
    expect(ring(button).style.strokeDasharray).toBe("0 100");
  });

  it("stays off a control marked aria-disabled", () => {
    render(
      <button type="button" aria-disabled="true">
        Record
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(ring(button).style.strokeDasharray).toBe("");
  });

  it("shapes the ring from the control's border edge on the first hover", () => {
    render(
      <button
        type="button"
        style={{ width: "40px", height: "28px", border: "1px solid", borderTopLeftRadius: "6px" }}
      >
        Play
        <HoverRing gap={2} />
      </button>,
    );
    const button = screen.getByRole("button");
    const svg = button.querySelector<SVGSVGElement>(".hover-ring")!;

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(svg.style.left).toBe("-3px");
    expect(svg.style.width).toBe("44px");
    expect(ring(button)).toHaveAttribute("x", "0.5");
    expect(ring(button)).toHaveAttribute("width", "43");
    expect(ring(button)).toHaveAttribute("rx", "7.5");
  });

  it("draws inside the edge beside a ringed control two pixels away", () => {
    render(
      <>
        <button type="button" style={{ width: "28px", height: "28px" }}>
          New file
          <HoverRing />
        </button>
        <button type="button" style={{ width: "28px", height: "28px" }}>
          New folder
          <HoverRing />
        </button>
      </>,
    );
    const [file, folder] = screen.getAllByRole("button");
    const at = (left: number) => () => DOMRect.fromRect({ x: left, y: 0, width: 28, height: 28 });
    vi.spyOn(file, "getBoundingClientRect").mockImplementation(at(0));
    vi.spyOn(folder, "getBoundingClientRect").mockImplementation(at(30));

    fireEvent.pointerEnter(file, { pointerType: "mouse" });
    const svg = file.querySelector<SVGSVGElement>(".hover-ring")!;
    // Half of the two pixels, less one between the lines, rounds down to none at 1x.
    expect(svg.style.left).toBe("0px");
    expect(svg.style.width).toBe("28px");
  });

  it("clears the ring it drew when it detaches", () => {
    const { rerender } = render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");
    fireEvent.pointerEnter(button, { pointerType: "mouse" });

    rerender(
      <button type="button">
        Play
        <HoverRing gap={0} />
      </button>,
    );
    expect(ring(button).style.strokeDasharray).toBe("");
    expect(ring(button).style.opacity).toBe("");
  });

  it("stops listening once unmounted", () => {
    const { unmount } = render(
      <button type="button">
        Play
        <HoverRing />
      </button>,
    );
    const button = screen.getByRole("button");
    const rect = ring(button);
    unmount();

    fireEvent.pointerEnter(button, { pointerType: "mouse" });
    expect(rect.style.strokeDasharray).toBe("");
  });
});
