import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";
import type { ChatImage, ChatItem } from "../../types/chat";
import TranscriptItem from "./AgentTranscript";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function image(id: string, dataUrl: string): ChatImage {
  return { id, dataUrl, mimeType: "image/png", name: id };
}

function message(images: ChatImage[], text = ""): ChatItem {
  return { kind: "message", id: "m1", role: "user", text, images };
}

describe("TranscriptItem message images", () => {
  // A replayed lesson's chat track carries its images as plain strings. Anything
  // but a pasted image's data: URL would make the app fetch a URL the author chose,
  // with the viewer's cookies when it is on this origin.
  it("shows only pasted images' data: URLs", () => {
    render(
      <TranscriptItem
        item={message([
          image("pasted", PNG),
          image("same-origin", "/api/auth/logout"),
          image("absolute", "https://elsewhere.example/pixel.png"),
          image("protocol-relative", "//elsewhere.example/pixel.png"),
          image("html", "data:text/html,<b>dummy</b>"),
          image("svg", "data:image/svg+xml,<svg/>"),
          image("blob", "blob:https://elsewhere.example/0"),
        ])}
      />,
    );

    expect(screen.getAllByRole("img").map((img) => img.getAttribute("src"))).toEqual([PNG]);
  });

  it("accepts every type the composer lets a reader paste", () => {
    const pasted = ["png", "jpeg", "gif", "webp"].map((type) =>
      image(type, `data:image/${type};base64,AAAA`),
    );
    render(<TranscriptItem item={message(pasted)} />);

    expect(screen.getAllByRole("img")).toHaveLength(4);
  });

  it("renders nothing for a message holding only unsafe images", () => {
    const { container } = render(
      <TranscriptItem item={message([image("pixel", "https://elsewhere.example/p.png")])} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
