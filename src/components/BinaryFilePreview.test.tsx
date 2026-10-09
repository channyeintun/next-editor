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
    expect(screen.getByRole("link", { name: /^Download/ })).toHaveFocus();
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
