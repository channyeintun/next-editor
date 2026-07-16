import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PreviewAdapterHandleProvider } from "../contexts/PreviewAdapterHandleContext";
import { PreviewPanelProvider } from "../contexts/PreviewPanelContext";
import { PreviewHeaderButton } from "./EditorHeader";

describe("PreviewHeaderButton", () => {
  it("opens the preview on the first click", () => {
    render(
      <PreviewAdapterHandleProvider>
        <PreviewPanelProvider>
          <PreviewHeaderButton />
        </PreviewPanelProvider>
      </PreviewAdapterHandleProvider>,
    );

    const button = screen.getByRole("button", { name: "Open preview" });
    fireEvent.click(button);

    expect(screen.getByRole("button", { name: "Close preview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
