import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { MAX_CAPTION_BYTES } from "../../lessons/uploadLimits";
import UploadCaptionsField, { type SelectedCaption } from "./UploadCaptionsField";

const english: SelectedCaption = { language: "en", fileName: "lesson.en.vtt", cues: [] };
const spanish: SelectedCaption = { language: "es", fileName: "lesson.es.vtt", cues: [] };

describe("UploadCaptionsField", () => {
  it("lists the attached tracks and removes one", () => {
    const onChange = vi.fn<(tracks: SelectedCaption[]) => void>();
    render(<UploadCaptionsField value={[english, spanish]} onChange={onChange} disabled={false} />);

    expect(screen.getByText("lesson.en.vtt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove en captions" }));

    expect(onChange).toHaveBeenCalledWith([spanish]);
  });

  it("refuses an oversized file without attaching anything", async () => {
    const onChange = vi.fn<(tracks: SelectedCaption[]) => void>();
    const { container } = render(
      <UploadCaptionsField value={[]} onChange={onChange} disabled={false} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    const file = new File([new Uint8Array(MAX_CAPTION_BYTES + 1)], "huge.vtt");

    fireEvent.change(input, { target: { files: [file] } });

    expect((await screen.findByRole("alert")).textContent).toBe(
      '"huge.vtt" is too large — 2MB max.',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("disables its controls while the form uploads", () => {
    render(<UploadCaptionsField value={[english]} onChange={() => {}} disabled />);

    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Remove en captions" }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Add caption file/ }).disabled,
    ).toBe(true);
  });
});
