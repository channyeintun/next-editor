import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkspaceAssetDescriptor, WorkspaceAssetFile } from "../types/workspace";

const assets = vi.hoisted(() => ({
  getBlob: vi.fn<(descriptor: WorkspaceAssetDescriptor) => Promise<Blob>>(),
}));

vi.mock("../storage/workspaceAssetStore", () => ({
  getWorkspaceAssetBlob: assets.getBlob,
  subscribeWorkspaceAssetAvailability: () => () => {},
}));

const { default: BinaryFilePreview } = await import("./BinaryFilePreview");

const photo: WorkspaceAssetFile = {
  path: "images/photo.png",
  name: "photo.png",
  language: "plaintext",
  encoding: "asset",
  content: { kind: "asset", assetId: "a1", mimeType: "image/png", size: 4 },
};

function deferred() {
  let resolve!: (blob: Blob) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Blob>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn<(blob: Blob) => string>(() => "blob:photo");
  URL.revokeObjectURL = vi.fn<(url: string) => void>();
});

afterEach(() => {
  assets.getBlob.mockReset();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});

/** Renders the preview with its first load already failed, so Retry is on screen. */
async function renderUnavailable() {
  assets.getBlob.mockRejectedValueOnce(new Error("missing"));
  render(<BinaryFilePreview file={photo} />);
  return screen.findByRole("button", { name: "Retry asset" });
}

describe("BinaryFilePreview download link", () => {
  it("names the file it downloads, after the visible word", async () => {
    assets.getBlob.mockResolvedValueOnce(new Blob(["png!"], { type: "image/png" }));
    render(<BinaryFilePreview file={photo} />);

    const link = await screen.findByRole("link", { name: "Download photo.png" });
    expect(link).toHaveAttribute("download", "photo.png");
  });
});

describe("BinaryFilePreview retry status", () => {
  it("stays silent until the reader presses Retry", async () => {
    await renderUnavailable();

    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("announces the retry and its success, then moves focus to Download", async () => {
    const retry = await renderUnavailable();
    const load = deferred();
    assets.getBlob.mockReturnValueOnce(load.promise);
    retry.focus();

    fireEvent.click(retry);
    expect(screen.getByRole("status")).toHaveTextContent("Retrying asset…");

    await act(async () => load.resolve(new Blob(["png!"], { type: "image/png" })));

    expect(screen.getByRole("status")).toHaveTextContent("photo.png loaded");
    expect(screen.queryByRole("button", { name: "Retry asset" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download photo.png" })).toHaveFocus();
  });

  it("announces a retry that fails again", async () => {
    const retry = await renderUnavailable();
    const load = deferred();
    assets.getBlob.mockReturnValueOnce(load.promise);

    fireEvent.click(retry);
    await act(async () => load.reject(new Error("still missing")));

    expect(screen.getByRole("status")).toHaveTextContent("Asset still unavailable");
    expect(screen.getByRole("button", { name: "Retry asset" })).toBeInTheDocument();
  });

  it("leaves focus alone when the reader moved on before the asset loaded", async () => {
    const retry = await renderUnavailable();
    const load = deferred();
    assets.getBlob.mockReturnValueOnce(load.promise);
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);

    fireEvent.click(retry);
    elsewhere.focus();
    await act(async () => load.resolve(new Blob(["png!"], { type: "image/png" })));

    expect(screen.getByRole("status")).toHaveTextContent("photo.png loaded");
    expect(elsewhere).toHaveFocus();
    elsewhere.remove();
  });
});

describe("BinaryFilePreview object URL type", () => {
  function asset(path: string, mimeType: string): WorkspaceAssetFile {
    const name = path.split("/").at(-1) ?? path;
    return {
      path,
      name,
      language: "plaintext",
      encoding: "asset",
      content: { kind: "asset", assetId: `id-${name}`, mimeType, size: 4 },
    };
  }

  /** The types of every Blob the preview turned into an app-origin object URL. */
  function objectUrlTypes(): string[] {
    return vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type);
  }

  // The declared type comes from whoever made the asset (a lesson's .ne, a room
  // peer, an importer). Opened in a tab, a blob URL renders as that type on the
  // app's origin, so a scriptable type must never reach one.
  it.each([
    ["notes.bin", "text/html"],
    ["logo.svg", "image/svg+xml"],
    ["diagram.png", "image/svg+xml"],
    ["page.xhtml", "application/xhtml+xml"],
    ["feed.xml", "text/xml"],
    ["clip.mp4", "video/mp4é"],
  ])("serves %s declared as %s as a download only", async (path, mimeType) => {
    const file = asset(path, mimeType);
    assets.getBlob.mockResolvedValueOnce(new Blob(["<b>"], { type: mimeType }));
    const { container } = render(<BinaryFilePreview file={file} />);

    const link = await screen.findByRole("link", { name: `Download ${file.name}` });
    expect(objectUrlTypes()).toEqual(["application/octet-stream"]);
    expect(link).toHaveAttribute("href", "blob:photo");
    expect(container.querySelector("img, video, audio")).toBeNull();
  });

  it("keeps a raster image's type and shows it inline", async () => {
    assets.getBlob.mockResolvedValueOnce(new Blob(["png!"], { type: "image/png" }));
    render(<BinaryFilePreview file={photo} />);

    expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute(
      "src",
      "blob:photo",
    );
    expect(objectUrlTypes()).toEqual(["image/png"]);
  });

  it("keeps a video's type and plays it inline", async () => {
    const clip = asset("media/clip.mp4", "video/mp4");
    assets.getBlob.mockResolvedValueOnce(new Blob(["mp4!"], { type: "video/mp4" }));
    const { container } = render(<BinaryFilePreview file={clip} />);

    await screen.findByRole("link", { name: "Download clip.mp4" });
    expect(container.querySelector("video")).toHaveAttribute("src", "blob:photo");
    expect(objectUrlTypes()).toEqual(["video/mp4"]);
  });
});
