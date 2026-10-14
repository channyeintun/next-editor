import { fireEvent, render, screen } from "@testing-library/react";
import { SquarePen } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import SettingsMenuItem from "./SettingsMenuItem";

describe("SettingsMenuItem", () => {
  it("is a menu item with the icon and label, styled as a settings item", () => {
    const onClick = vi.fn<() => void>();
    render(<SettingsMenuItem icon={SquarePen} label="New Editor" onClick={onClick} />);

    const item = screen.getByRole("menuitem", { name: "New Editor" });
    expect(item).toHaveAttribute("type", "button");
    expect(item).toBeEnabled();
    expect(item.className).toBe(
      "group flex w-full items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors text-slate-200 enabled:hover:bg-slate-700 enabled:hover:text-white disabled:cursor-not-allowed disabled:text-slate-500",
    );
    // The icon sits in a fixed 16px slot, so every row's icon lines up in one column.
    const slot = item.querySelector("span");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toHaveClass("size-4", "shrink-0", "text-slate-400");
    expect(slot?.querySelector("svg")).toHaveAttribute("width", "16");

    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("can be disabled", () => {
    const onClick = vi.fn<() => void>();
    render(<SettingsMenuItem icon={SquarePen} label="New Editor" onClick={onClick} disabled />);

    const item = screen.getByRole("menuitem", { name: "New Editor" });
    expect(item).toBeDisabled();

    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();
  });
});
