import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Recording } from "@app/core/src";
import type * as UploadLessonModule from "./uploadLesson";
import type { UploadedLesson, UploadLessonInput } from "./uploadLesson";

const uploadLesson = vi.hoisted(() =>
  vi.fn<(lessonId: string, input: UploadLessonInput) => Promise<UploadedLesson>>(),
);

vi.mock("./uploadLesson", async (importOriginal) => ({
  ...(await importOriginal<typeof UploadLessonModule>()),
  uploadLesson: (lessonId: string, input: UploadLessonInput) => uploadLesson(lessonId, input),
}));

const { useUploadLesson } = await import("./useUploadLesson");

const recording: Recording = {
  version: 4,
  id: "take-1",
  name: "Take",
  createdAt: 1,
  duration: 1000,
  keyframeInterval: 120,
  frames: [],
};

const input: UploadLessonInput = { recording, title: "Take", description: "", tags: [] };

function renderUploadHook(queryClient: QueryClient) {
  return renderHook(() => useUploadLesson(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

// What My Library and its playlist cards had cached before the upload.
function seedLibrary(queryClient: QueryClient) {
  queryClient.setQueryData(["lessons", "mine"], []);
  queryClient.setQueryData(["playlists", "mine"], []);
}

describe("useUploadLesson", () => {
  beforeEach(() => {
    uploadLesson.mockReset();
  });

  // The query client keeps lists until a mutation marks them stale: without
  // this, My Library would keep showing the list without the new draft.
  it("marks My Library and the playlist cards stale once the draft is uploaded", async () => {
    const queryClient = new QueryClient();
    seedLibrary(queryClient);
    uploadLesson.mockResolvedValue({ id: "l1", slug: "take" });
    const { result } = renderUploadHook(queryClient);

    await act(() => result.current.upload({ lessonId: "l1", input }));

    expect(queryClient.getQueryState(["lessons", "mine"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["playlists", "mine"])?.isInvalidated).toBe(true);
  });

  it("leaves the cached library alone when the upload fails", async () => {
    const queryClient = new QueryClient();
    seedLibrary(queryClient);
    uploadLesson.mockRejectedValue(new Error("network"));
    const { result } = renderUploadHook(queryClient);

    await act(() =>
      expect(result.current.upload({ lessonId: "l1", input })).rejects.toThrow("network"),
    );

    expect(queryClient.getQueryState(["lessons", "mine"])?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(["playlists", "mine"])?.isInvalidated).toBe(false);
  });
});
