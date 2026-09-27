import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  useDismissOnOutsideInteraction,
  type DismissOnOutsideInteractionOptions,
} from "./useDismissOnOutsideInteraction";

type HarnessProps = Omit<DismissOnOutsideInteractionOptions, "containerRef">;

function Harness(props: HarnessProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useDismissOnOutsideInteraction({ ...props, containerRef });
  return (
    <>
      <div ref={containerRef}>
        <button type="button">Inside</button>
      </div>
      <button type="button">Outside</button>
    </>
  );
}

function renderHarness(overrides: Partial<HarnessProps> = {}) {
  const props: HarnessProps = {
    isOpen: true,
    onDismiss: vi.fn<() => void>(),
    dismissOnEscape: true,
    listenOn: "window",
    ...overrides,
  };
  const view = render(<Harness {...props} />);
  return {
    ...view,
    onDismiss: props.onDismiss,
    rerenderWith: (next: Partial<HarnessProps>) => view.rerender(<Harness {...props} {...next} />),
  };
}

describe("useDismissOnOutsideInteraction", () => {
  it.each(["window", "document"] as const)(
    "closes on a pointer-down outside the container, never inside it (%s)",
    (listenOn) => {
      const { onDismiss } = renderHarness({ listenOn });

      fireEvent.pointerDown(screen.getByRole("button", { name: "Inside" }));
      expect(onDismiss).not.toHaveBeenCalled();

      fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
      expect(onDismiss).toHaveBeenCalledTimes(1);
    },
  );

  it("closes on Escape and ignores other keys", () => {
    const { onDismiss } = renderHarness();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Enter" });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(screen.getByRole("button", { name: "Inside" }), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone unless asked to close on it", () => {
    const { onDismiss } = renderHarness({ dismissOnEscape: false });

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("listens only while the popup is open", () => {
    const { onDismiss, rerenderWith } = renderHarness({ isOpen: false });
    const outside = screen.getByRole("button", { name: "Outside" });

    fireEvent.pointerDown(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();

    rerenderWith({ isOpen: true });
    fireEvent.pointerDown(outside);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerenderWith({ isOpen: false });
    fireEvent.pointerDown(outside);
    fireEvent.keyDown(outside, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the component unmounts", () => {
    const { onDismiss, unmount } = renderHarness();
    unmount();

    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("puts its listeners on the target it is given", () => {
    const onWindow = renderHarness({ listenOn: "window" });
    const onDocument = renderHarness({ listenOn: "document" });

    // An event dispatched to the window itself never reaches the document.
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onWindow.onDismiss).toHaveBeenCalledTimes(1);
    expect(onDocument.onDismiss).not.toHaveBeenCalled();

    // One that bubbles from an element reaches both.
    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(onWindow.onDismiss).toHaveBeenCalledTimes(2);
    expect(onDocument.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("calls the onDismiss of the latest render", () => {
    const first = vi.fn<() => void>();
    const latest = vi.fn<() => void>();
    const { rerenderWith } = renderHarness({ onDismiss: first });

    rerenderWith({ onDismiss: latest });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});
