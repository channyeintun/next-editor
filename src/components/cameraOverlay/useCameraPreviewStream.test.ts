import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useCameraPreviewStream } from "./useCameraPreviewStream";

function fakeStream() {
  const track = { stop: vi.fn<() => void>() };
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

function fakeVideo() {
  return {
    srcObject: null as MediaStream | null,
    play: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<unknown>;

function stubGetUserMedia(getUserMedia: GetUserMedia) {
  const spy = vi.fn<GetUserMedia>(getUserMedia);
  vi.stubGlobal("navigator", { ...navigator, mediaDevices: { getUserMedia: spy } });
  return spy;
}

const renderPreview = (video: ReturnType<typeof fakeVideo>, previewMode = true) => {
  const videoRef = { current: video as unknown as HTMLVideoElement };
  return renderHook(
    ({ previewMode, isMinimized }) => useCameraPreviewStream(videoRef, previewMode, isMinimized),
    { initialProps: { previewMode, isMinimized: false } },
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCameraPreviewStream", () => {
  it("shows the front camera while preview mode is on, and stops it after", async () => {
    const { stream, track } = fakeStream();
    const getUserMedia = stubGetUserMedia(() => Promise.resolve(stream));
    const video = fakeVideo();
    const { result, rerender } = renderPreview(video);

    await waitFor(() => expect(video.srcObject).toBe(stream));
    expect(video.play).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({
      video: {
        width: { ideal: 480 },
        height: { ideal: 480 },
        frameRate: { ideal: 24, max: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    expect(result.current).toBe(false);

    rerender({ previewMode: false, isMinimized: false });
    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("does not open the camera outside preview mode", () => {
    const getUserMedia = stubGetUserMedia(() => Promise.resolve(fakeStream().stream));
    renderPreview(fakeVideo(), false);

    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("puts the same stream back when the video comes back from minimized", async () => {
    const { stream } = fakeStream();
    const getUserMedia = stubGetUserMedia(() => Promise.resolve(stream));
    const video = fakeVideo();
    const { rerender } = renderPreview(video);
    await waitFor(() => expect(video.srcObject).toBe(stream));

    rerender({ previewMode: true, isMinimized: true });
    // The remounted element starts empty.
    video.srcObject = null;
    rerender({ previewMode: true, isMinimized: false });

    expect(video.srcObject).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stops a stream that arrives after preview mode ended", async () => {
    const { stream, track } = fakeStream();
    let deliver: (stream: MediaStream) => void = () => {};
    stubGetUserMedia(() => new Promise((resolve) => (deliver = resolve)));
    const video = fakeVideo();
    const { rerender } = renderPreview(video);

    rerender({ previewMode: false, isMinimized: false });
    await act(async () => deliver(stream));

    expect(track.stop).toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("reports a camera the viewer refused, until preview mode ends", async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException("Denied", "NotAllowedError")));
    const { result, rerender } = renderPreview(fakeVideo());

    await waitFor(() => expect(result.current).toBe(true));
    rerender({ previewMode: false, isMinimized: false });
    expect(result.current).toBe(false);
  });

  it("reports a browser without camera access", () => {
    vi.stubGlobal("navigator", { ...navigator, mediaDevices: undefined });
    const { result } = renderPreview(fakeVideo());

    expect(result.current).toBe(true);
  });
});
