import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ChatImage } from "../../types/chat";
import DraftImageStrip from "./DraftImageStrip";

const named: ChatImage = {
  id: "named",
  dataUrl: "data:image/png;base64,AAAA",
  mimeType: "image/png",
  name: "shot.png",
};
const unnamed: ChatImage = {
  id: "unnamed",
  dataUrl: "data:image/png;base64,BBBB",
  mimeType: "image/png",
};

describe("DraftImageStrip", () => {
  it("renders nothing when no image is pasted", () => {
    const { container } = render(<DraftImageStrip images={[]} onRemove={() => {}} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("shows each pasted image with a remove button named after it", () => {
    const onRemove = vi.fn<(imageId: string) => void>();
    render(<DraftImageStrip images={[named, unnamed]} onRemove={onRemove} />);

    expect(screen.getByRole("img", { name: "shot.png" })).toHaveAttribute("src", named.dataUrl);
    expect(screen.getByRole("img", { name: "Pasted image" })).toHaveAttribute(
      "src",
      unnamed.dataUrl,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove pasted image" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));

    expect(onRemove.mock.calls).toEqual([["unnamed"], ["named"]]);
  });
});
