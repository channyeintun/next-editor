import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import LandingPage from "./LandingPage";

const device = vi.hoisted(() => ({ mobile: false }));
vi.mock("../utils/isMobileBrowser", () => ({ isMobileBrowser: () => device.mobile }));

class InertObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  device.mobile = false;
  vi.useFakeTimers();
  // Idle then runs on the one-tick timer Safari gets.
  vi.stubGlobal("requestIdleCallback", undefined);
  vi.stubGlobal("IntersectionObserver", InertObserver);
  vi.stubGlobal("ResizeObserver", InertObserver);
  // Reduced motion, so the hero's framework ticker sets no interval.
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.spyOn(document, "readyState", "get").mockReturnValue("interactive");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderLandingPage() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

describe("LandingPage demo embed", () => {
  it("shows the poster on desktop and mounts the demo only after load and idle", () => {
    const { container } = renderLandingPage();

    expect(container.querySelector('img[src="/lessons/introduction/thumbnail.webp"]')).not.toBe(
      null,
    );
    act(() => vi.runAllTimers());
    expect(screen.queryByTitle("Next Editor Live Demo")).toBe(null);

    act(() => {
      window.dispatchEvent(new Event("load"));
    });
    expect(screen.queryByTitle("Next Editor Live Demo")).toBe(null);
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByTitle("Next Editor Live Demo").getAttribute("src")).toBe(
      "/code?url=/lessons/introduction/introduction.ne&readOnly=true&deferRuntimeAutostart=true&largeControls=true",
    );
  });

  it("never mounts the demo on mobile", () => {
    device.mobile = true;
    const { container } = renderLandingPage();

    act(() => {
      window.dispatchEvent(new Event("load"));
      vi.runAllTimers();
    });

    expect(screen.queryByTitle("Next Editor Live Demo")).toBe(null);
    expect(container.querySelector('img[src="/lessons/introduction/thumbnail.webp"]')).toBe(null);
    expect(screen.getByRole("link", { name: "Open the interactive demo" })).toBeInTheDocument();
  });
});
