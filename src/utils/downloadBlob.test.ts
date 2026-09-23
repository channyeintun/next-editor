import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./downloadBlob";

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

describe("downloadBlob", () => {
  it("clicks an attached download link and revokes its URL only later", () => {
    vi.useFakeTimers();
    URL.createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:download");
    const revoke = vi.fn<(url: string) => void>();
    URL.revokeObjectURL = revoke;
    const clicks: Array<{ href: string; download: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function (this: HTMLAnchorElement) {
        clicks.push({ href: this.href, download: this.download, attached: this.isConnected });
      },
    );

    downloadBlob(new Blob(["bytes"]), "lesson.ne");

    expect(clicks).toEqual([{ href: "blob:download", download: "lesson.ne", attached: true }]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revoke).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);

    expect(revoke).toHaveBeenCalledWith("blob:download");
  });
});
