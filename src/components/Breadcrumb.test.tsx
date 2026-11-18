import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import Breadcrumb from "./Breadcrumb";

function renderBreadcrumb(title: string) {
  return render(
    <MemoryRouter>
      <Breadcrumb title={title} />
    </MemoryRouter>,
  );
}

describe("Breadcrumb", () => {
  it("links back to the lesson gallery", () => {
    renderBreadcrumb("Rust from zero: Ownership");

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(screen.getByRole("link", { name: "Lessons" })).toHaveAttribute("href", "/learn");
    expect(trail).toHaveTextContent("Rust from zero: Ownership");
    expect(trail.querySelector("[lang]")).toBeNull();
  });

  it("links back to the given parent instead of the gallery", () => {
    render(
      <MemoryRouter>
        <Breadcrumb
          title="Your first Go program"
          parent={{ to: "/learn/playlist/go-course", label: "Go ကို စတင်လေ့လာခြင်း" }}
        />
      </MemoryRouter>,
    );

    const parent = screen.getByRole("link", { name: "Go ကို စတင်လေ့လာခြင်း" });
    expect(parent).toHaveAttribute("href", "/learn/playlist/go-course");
    expect(parent.querySelector('span[lang="my"]')).not.toBeNull();
    expect(screen.queryByRole("link", { name: "Lessons" })).toBeNull();
  });

  it("marks the Burmese part of the lesson title as lang=my", () => {
    renderBreadcrumb("Next Editor ကို မိတ်ဆက်ခြင်း");

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    const burmese = trail.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("ကို မိတ်ဆက်ခြင်း");
  });
});

describe("Breadcrumb parent menu", () => {
  const label = "Lessons in Go from zero";

  function renderMenu() {
    return render(
      <MemoryRouter>
        <Breadcrumb
          title="Your first Go program"
          parent={{
            to: "/learn/playlist/go-course",
            label: "Go from zero",
            menu: {
              label,
              content: (
                <ol>
                  <li>
                    <Link to="/learn/variables?list=go-course">Variables</Link>
                  </li>
                </ol>
              ),
            },
          }}
        />
        <button type="button">Elsewhere</button>
      </MemoryRouter>,
    );
  }

  const toggle = () => screen.getByRole("button", { name: label });
  const panel = () => screen.queryByRole("group", { name: label });
  const crumb = () => screen.getByRole("link", { name: "Go from zero" }).parentElement!;
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the crumb a link to the playlist, with a collapsed toggle beside it", () => {
    renderMenu();

    expect(screen.getByRole("link", { name: "Go from zero" })).toHaveAttribute(
      "href",
      "/learn/playlist/go-course",
    );
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeNull();
  });

  it("opens and closes from the toggle, which names the panel it controls", () => {
    renderMenu();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(panel()).toHaveAttribute("id", toggle().getAttribute("aria-controls"));
    expect(screen.getByRole("link", { name: "Variables" })).toBeInTheDocument();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeNull();
  });

  it("opens when the pointer rests on the crumb, and stays while it moves onto the panel", () => {
    renderMenu();

    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    expect(panel()).toBeNull();
    advance(150);
    expect(panel()).not.toBeNull();

    // Leaving the crumb waits, so the pointer can reach the panel; coming back keeps it.
    fireEvent.pointerLeave(crumb(), { pointerType: "mouse" });
    advance(200);
    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    advance(1_000);
    expect(panel()).not.toBeNull();

    fireEvent.pointerLeave(crumb(), { pointerType: "mouse" });
    advance(300);
    expect(panel()).toBeNull();
  });

  it("does not open for a pointer that only passes over the crumb", () => {
    renderMenu();

    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    advance(100);
    fireEvent.pointerLeave(crumb(), { pointerType: "mouse" });
    advance(1_000);
    expect(panel()).toBeNull();
  });

  it("ignores touch, where a tap goes to the link or the toggle", () => {
    renderMenu();

    fireEvent.pointerEnter(crumb(), { pointerType: "touch" });
    advance(1_000);
    expect(panel()).toBeNull();
  });

  it("closes on Escape without the pointer moving, and stays closed while it rests there", () => {
    renderMenu();
    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    advance(150);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
    // Focus was not in it, so focus is left where it was.
    expect(toggle()).not.toHaveFocus();

    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    advance(1_000);
    expect(panel()).toBeNull();
  });

  it("returns focus to the toggle when Escape closes the panel focus is in", () => {
    renderMenu();
    fireEvent.click(toggle());
    screen.getByRole("link", { name: "Variables" }).focus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
    expect(toggle()).toHaveFocus();
  });

  it("stays open when the pointer leaves a panel the toggle opened", () => {
    renderMenu();
    fireEvent.click(toggle());

    fireEvent.pointerLeave(crumb(), { pointerType: "mouse" });
    advance(1_000);
    expect(panel()).not.toBeNull();
  });

  it("keeps a hover-opened panel open once focus moves into it", () => {
    renderMenu();
    fireEvent.pointerEnter(crumb(), { pointerType: "mouse" });
    advance(150);

    fireEvent.focus(screen.getByRole("link", { name: "Variables" }));
    fireEvent.pointerLeave(crumb(), { pointerType: "mouse" });
    advance(1_000);
    expect(panel()).not.toBeNull();
  });

  it("closes on a press outside, on focus moving elsewhere, and on following a link in it", () => {
    renderMenu();

    fireEvent.click(toggle());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(panel()).toBeNull();

    fireEvent.click(toggle());
    fireEvent.blur(toggle(), {
      relatedTarget: screen.getByRole("button", { name: "Elsewhere" }),
    });
    expect(panel()).toBeNull();

    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("link", { name: "Variables" }));
    expect(panel()).toBeNull();
  });
});
