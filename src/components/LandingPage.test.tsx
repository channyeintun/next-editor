import { act, fireEvent, render, screen } from "@testing-library/react";
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
  it("mounts the demo on desktop only after load and idle, with no poster before it", () => {
    const { container } = renderLandingPage();

    // A poster under the frame flashed against the frame's own skeleton.
    expect(container.querySelector('img[src*="/lessons/introduction/"]')).toBe(null);
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
    renderLandingPage();

    act(() => {
      window.dispatchEvent(new Event("load"));
      vi.runAllTimers();
    });

    expect(screen.queryByTitle("Next Editor Live Demo")).toBe(null);
    // Named by its visible label, so "click Play the interactive demo" matches.
    expect(screen.getByRole("link", { name: /^Play the interactive demo/ })).toBeInTheDocument();
  });
});

describe("LandingPage decorative graphics", () => {
  it("hides every inline SVG from assistive technology", () => {
    const { container } = renderLandingPage();
    const svgs = [...container.querySelectorAll("svg")];

    expect(svgs.length).toBeGreaterThan(0);
    expect(svgs.filter((svg) => svg.getAttribute("aria-hidden") !== "true")).toEqual([]);
  });
});

describe("LandingPage framework rotation", () => {
  function worksWithHeading() {
    // One stable name for screen readers; the rotating word is aria-hidden.
    return screen.getByRole("heading", { level: 2, name: /^Works with\s*any JS\/TS framework$/ });
  }

  it("stops rotating when the user pauses it and resumes on play", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    renderLandingPage();
    const heading = worksWithHeading();
    const initialText = heading.textContent;

    act(() => vi.advanceTimersByTime(2000));
    const rotatedText = heading.textContent;
    expect(rotatedText).not.toBe(initialText);

    fireEvent.click(screen.getByRole("button", { name: "Pause animation" }));
    act(() => vi.advanceTimersByTime(4000));
    expect(heading.textContent).toBe(rotatedText);

    fireEvent.click(screen.getByRole("button", { name: "Play animation" }));
    act(() => vi.advanceTimersByTime(2000));
    expect(heading.textContent).not.toBe(rotatedText);
    expect(worksWithHeading()).toBe(heading);
  });

  it("neither rotates nor shows the control under reduced motion", () => {
    renderLandingPage();
    const heading = worksWithHeading();
    const initialText = heading.textContent;

    act(() => vi.advanceTimersByTime(4000));

    expect(heading.textContent).toBe(initialText);
    expect(screen.queryByRole("button", { name: /animation/ })).toBe(null);
  });
});

describe("LandingPage fullscreen focus", () => {
  let fullscreenElement: Element | null = null;
  const setFullscreen = (element: Element | null) => {
    fullscreenElement = element;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };

  beforeEach(() => {
    fullscreenElement = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(document, "exitFullscreen", {
      configurable: true,
      value: () => setFullscreen(null),
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value(this: HTMLElement) {
        return setFullscreen(this);
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, "fullscreenElement");
    Reflect.deleteProperty(document, "exitFullscreen");
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  });

  it("moves focus to the in-demo Exit button and back to the covered toggle", () => {
    renderLandingPage();
    const toggle = screen.getByRole("button", { name: "View demo in full screen" });
    toggle.focus();

    fireEvent.click(toggle);

    // The header toggle is now covered; focus lands on the first tab stop
    // inside the fullscreen element.
    const exit = screen
      .getAllByRole("button", { name: "Exit full screen" })
      .find((button) => button !== toggle);
    expect(exit).toBeDefined();
    expect(document.activeElement).toBe(exit);
    expect(fullscreenElement?.querySelector("a, button, iframe")).toBe(exit);

    fireEvent.click(exit!);
    expect(document.activeElement).toBe(toggle);

    // Leaving with the browser's own Esc handling restores focus too.
    fireEvent.click(toggle);
    expect(document.activeElement).not.toBe(toggle);
    act(() => {
      void setFullscreen(null);
    });
    expect(document.activeElement).toBe(toggle);
  });
});
