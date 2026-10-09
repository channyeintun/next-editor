import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@next-editor/infra", () => ({ AuthMenu: () => null }));
// The grid's queries and virtualizer are beside the point here.
vi.mock("./components/LessonGrid", () => ({ default: () => null }));

const { default: LearnPage } = await import("./LearnPage");

describe("LearnPage", () => {
  it("names the view with a top-level heading inside the main landmark", () => {
    render(
      <MemoryRouter>
        <LearnPage />
      </MemoryRouter>,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "Lessons" });
    expect(screen.getByRole("main")).toContainElement(heading);
  });
});
