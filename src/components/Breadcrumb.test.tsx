import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vite-plus/test";
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

  it("marks the Burmese part of the lesson title as lang=my", () => {
    renderBreadcrumb("Next Editor ကို မိတ်ဆက်ခြင်း");

    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    const burmese = trail.querySelectorAll('span[lang="my"]');
    expect(burmese).toHaveLength(1);
    expect(burmese[0].textContent).toBe("ကို မိတ်ဆက်ခြင်း");
  });
});
