import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PreparedThumbnail } from "./prepareThumbnail";
import UploadThumbnailField, { type ThumbnailSelection } from "./UploadThumbnailField";

const prepareThumbnail = vi.hoisted(() => vi.fn<(file: File) => Promise<PreparedThumbnail>>());

vi.mock("./prepareThumbnail", () => ({
  prepareThumbnail: (file: File) => prepareThumbnail(file),
}));

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
const revoke = vi.fn<(url: string) => void>();

// The form owns the selection; this stands in for it.
function Harness({
  onChange,
  initial = { kind: "none" },
}: {
  onChange: (value: ThumbnailSelection) => void;
  initial?: ThumbnailSelection;
}) {
  const [value, setValue] = useState<ThumbnailSelection>(initial);
  return (
    <UploadThumbnailField
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
      disabled={false}
    />
  );
}

function pickFile(container: HTMLElement, file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("no file input");
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  let next = 0;
  URL.createObjectURL = vi.fn<(blob: Blob) => string>(() => `blob:preview-${++next}`);
  revoke.mockReset();
  URL.revokeObjectURL = revoke;
  prepareThumbnail.mockReset();
});

afterEach(() => {
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("UploadThumbnailField", () => {
  it("selects a prepared image and previews it", async () => {
    const resized = new File(["webp"], "cover.webp", { type: "image/webp" });
    prepareThumbnail.mockResolvedValue({ file: resized });
    const onChange = vi.fn<(value: ThumbnailSelection) => void>();
    const { container } = render(<Harness onChange={onChange} />);

    pickFile(container, new File(["png"], "cover.png", { type: "image/png" }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ kind: "file", file: resized }));
    const preview = await screen.findByRole<HTMLImageElement>("img", {
      name: "Thumbnail preview",
    });
    expect(preview.getAttribute("src")).toBe("blob:preview-1");
    expect(screen.queryByText("Default")).toBeNull();
  });

  it("shows why a picked image can't be used and keeps the selection", async () => {
    prepareThumbnail.mockResolvedValue({ error: "Choose a PNG or JPG image." });
    const onChange = vi.fn<(value: ThumbnailSelection) => void>();
    const { container } = render(<Harness onChange={onChange} />);

    pickFile(container, new File(["gif"], "cover.gif", { type: "image/gif" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Choose a PNG or JPG image.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("selects the default thumbnail", () => {
    const onChange = vi.fn<(value: ThumbnailSelection) => void>();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Use default thumbnail" }));

    expect(onChange).toHaveBeenCalledWith({ kind: "default" });
    expect(screen.getByRole("img", { name: "Thumbnail preview" }).getAttribute("src")).toBe(
      "/default-thumbnail.webp",
    );
    expect(screen.getByText("Default")).toBeTruthy();
  });

  it("clears the selection and revokes the preview when removed", async () => {
    const file = new File(["webp"], "cover.webp", { type: "image/webp" });
    const onChange = vi.fn<(value: ThumbnailSelection) => void>();
    render(<Harness onChange={onChange} initial={{ kind: "file", file }} />);
    await screen.findByRole("img", { name: "Thumbnail preview" });

    fireEvent.click(screen.getByRole("button", { name: "Remove thumbnail" }));

    expect(onChange).toHaveBeenCalledWith({ kind: "none" });
    expect(screen.getByRole("button", { name: "Select image" })).toBeTruthy();
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  // Remounting (the form comes back after the "Cancel upload?" view) previews
  // the selection it was given again instead of losing it.
  it("previews a file it was given on mount and revokes it on unmount", async () => {
    const file = new File(["webp"], "cover.webp", { type: "image/webp" });
    const { unmount } = render(
      <UploadThumbnailField value={{ kind: "file", file }} onChange={() => {}} disabled={false} />,
    );
    const preview = await screen.findByRole("img", { name: "Thumbnail preview" });
    expect(preview.getAttribute("src")).toBe("blob:preview-1");
    expect(revoke).not.toHaveBeenCalled();

    unmount();

    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });
});
