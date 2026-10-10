import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Y from "yjs";
import type { CollaborationRoomProvider } from "../../collaboration/roomProvider";
import {
  projectCollaborationTeachingDocument,
  seedCollaborationTeachingDocument,
  UNINITIALIZED_TEACHING_PROJECTION,
} from "../../collaboration/teachingDocument";
import type { WhiteboardEvent } from "../../core/src/whiteboard";
import type { SlideEvent } from "../../types/slides";
import { useCollaborationTeaching } from "./useCollaborationTeaching";

vi.mock("@next-editor/infra", () => ({
  downloadCollaborationAsset: vi.fn<() => Promise<Uint8Array>>(),
  initializeCollaborationTeachingSurfaces: vi.fn<() => Promise<void>>(),
  uploadCollaborationAsset: vi.fn<() => Promise<void>>(),
}));

const ROOM_ID = "room-1";
const ASSET = {
  id: "a".repeat(64),
  mimeType: "application/vnd.next-editor.slide+json",
  size: 100,
};

function seededDoc(): Y.Doc {
  const doc = new Y.Doc();
  seedCollaborationTeachingDocument(doc, {
    slides: [
      {
        slide: { id: "one", order: 0, content: "<h1>one</h1>", contentType: "html" },
        asset: ASSET,
      },
      {
        slide: { id: "two", order: 1, content: "<h1>two</h1>", contentType: "html" },
        asset: { ...ASSET, id: "b".repeat(64) },
      },
    ],
    whiteboardElements: [],
  });
  return doc;
}

function renderTeaching(doc: Y.Doc) {
  const setError = vi.fn<(message: string | null) => void>();
  const rendered = renderHook(() =>
    useCollaborationTeaching({
      providerRef: { current: { doc } as unknown as CollaborationRoomProvider },
      userRef: { current: null },
      isRecordingRef: { current: false },
      playbackRef: { current: false },
      standaloneStoresRef: { current: null },
      handleSlideEvent: vi.fn<(event: SlideEvent) => void>(),
      handleWhiteboardEvent: vi.fn<(event: WhiteboardEvent) => void>(),
      setError,
      setRetryableAssetError: vi.fn<(message: string | null) => void>(),
    }),
  );
  return { ...rendered, setError };
}

describe("useCollaborationTeaching", () => {
  it("resets to the uninitialized projection with no slides", () => {
    const doc = new Y.Doc();
    seedCollaborationTeachingDocument(doc, { slides: [], whiteboardElements: [] });
    const { result } = renderTeaching(doc);

    act(() => result.current.projectTeachingState(doc, ROOM_ID));
    expect(result.current.teaching.initialized).toBe(true);
    expect(result.current.teachingSlides).toEqual([]);

    act(() => {
      result.current.beginTeachingLoad();
      result.current.resetTeaching();
    });

    expect(result.current.teaching).toBe(UNINITIALIZED_TEACHING_PROJECTION);
    expect(result.current.teachingSlides).toBeNull();
    expect(result.current.isTeachingLoading).toBe(false);
    doc.destroy();
  });

  it("does not move the room's slide without write access", () => {
    const doc = seededDoc();
    const { result } = renderTeaching(doc);

    expect(result.current.publishCurrentSlide("two", false)).toBe(false);
    expect(projectCollaborationTeachingDocument(doc).currentSlideId).toBe("one");

    expect(result.current.publishCurrentSlide("two", true)).toBe(true);
    expect(projectCollaborationTeachingDocument(doc).currentSlideId).toBe("two");
    doc.destroy();
  });

  it("does not share a whiteboard delta without write access", () => {
    const doc = seededDoc();
    const { result, setError } = renderTeaching(doc);

    expect(result.current.publishWhiteboardDelta({ removedIds: ["shape"] }, false)).toBe(false);
    expect(setError).not.toHaveBeenCalled();
    doc.destroy();
  });
});
