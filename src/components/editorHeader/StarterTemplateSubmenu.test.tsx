import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceLessonType } from "../../types/workspace";
import StarterTemplateSubmenu, { type LessonTypeOption } from "./StarterTemplateSubmenu";

const options: LessonTypeOption[] = [
  { value: "html-css", label: "HTML/CSS" },
  { value: "react", label: "React" },
];

function renderSubmenu(isVisible = true) {
  const onSelect = vi.fn<(lessonType: WorkspaceLessonType) => void>();
  const submenu = (visible: boolean) => (
    <StarterTemplateSubmenu
      isVisible={visible}
      options={options}
      activeLessonType="react"
      onSelect={onSelect}
    />
  );
  const view = render(submenu(isVisible));
  return {
    ...view,
    onSelect,
    entry: () => screen.getByRole("menuitem", { name: "Starter Template" }),
    flyout: () => screen.queryByRole("menu", { name: "Starter templates" }),
    setVisible: (visible: boolean) => view.rerender(submenu(visible)),
  };
}

describe("StarterTemplateSubmenu", () => {
  it("renders nothing while hidden", () => {
    const { container } = renderSubmenu(false);

    expect(container).toBeEmptyDOMElement();
  });

  it("opens its flyout on hover or click, and closes it when the pointer leaves", () => {
    const { entry, flyout } = renderSubmenu();
    expect(entry()).toHaveAttribute("aria-expanded", "false");
    expect(flyout()).toBeNull();

    fireEvent.mouseEnter(entry().parentElement!);
    expect(entry()).toHaveAttribute("aria-expanded", "true");
    expect(flyout()).not.toBeNull();

    fireEvent.mouseLeave(entry().parentElement!);
    expect(flyout()).toBeNull();

    fireEvent.click(entry());
    expect(flyout()).not.toBeNull();
    fireEvent.click(entry());
    expect(flyout()).toBeNull();
  });

  it("marks the active lesson type and reports the one picked", () => {
    const { entry, onSelect } = renderSubmenu();
    fireEvent.click(entry());

    const react = screen.getByRole("menuitemradio", { name: /React/ });
    expect(react).toHaveAttribute("aria-checked", "true");
    expect(react).toHaveTextContent("Active");
    expect(screen.getByRole("menuitemradio", { name: "HTML/CSS" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: "HTML/CSS" }));
    expect(onSelect).toHaveBeenCalledWith("html-css");
  });

  it("keeps the flyout open across being hidden and shown again", () => {
    const { entry, flyout, setVisible } = renderSubmenu();
    fireEvent.click(entry());

    setVisible(false);
    setVisible(true);

    expect(flyout()).not.toBeNull();
  });
});
