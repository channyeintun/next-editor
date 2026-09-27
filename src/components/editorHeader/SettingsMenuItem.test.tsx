import { fireEvent, render, screen } from "@testing-library/react";
import { FilePlus2 } from "lucide-react";
import { describe, expect, it, vi } from "vite-plus/test";
import SettingsMenuItem from "./SettingsMenuItem";

describe("SettingsMenuItem", () => {
  it("is a menu item with the icon and label, styled as a settings item", () => {
    const onClick = vi.fn<() => void>();
    render(<SettingsMenuItem icon={FilePlus2} label="New Editor" onClick={onClick} />);

    const item = screen.getByRole("menuitem", { name: "New Editor" });
    expect(item).toHaveAttribute("type", "button");
    expect(item).toBeEnabled();
    expect(item.className).toBe(
      "w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-slate-200 transition-colors hover:bg-slate-700 hover:text-white",
    );
    expect(item.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("can be disabled and given its own classes", () => {
    const onClick = vi.fn<() => void>();
    render(
      <SettingsMenuItem
        icon={FilePlus2}
        label="New Editor"
        onClick={onClick}
        disabled
        className="cursor-not-allowed"
      />,
    );

    const item = screen.getByRole("menuitem", { name: "New Editor" });
    expect(item).toBeDisabled();
    expect(item.className).toBe("cursor-not-allowed");

    fireEvent.click(item);
    expect(onClick).not.toHaveBeenCalled();
  });
});
