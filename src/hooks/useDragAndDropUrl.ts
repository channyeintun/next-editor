import { useEffect, useRef, useState } from "react";
import type { UrlLoader } from "./useUrlLoader";

/** Loads a `.ne` file or `.ne` URL dropped anywhere on the document with the given loader. */
export const useDragAndDropUrl = ({
  fetchNextEditorFile,
  importNextEditorFile,
  isNextEditorUrl,
}: UrlLoader) => {
  const [isDragging, setIsDragging] = useState(false);
  // Outlives the effect below, which re-subscribes whenever the loader's functions change.
  const enteredElementsRef = useRef(0);

  useEffect(() => {
    // Whether the drag carries something this page can load: a file or a URL.
    const carriesDroppable = (e: DragEvent) => {
      const types = e.dataTransfer?.types;
      return Boolean(types?.includes("text/plain") || types?.includes("Files"));
    };

    // The overlay shows while a droppable drag is over a part of the page that takes it (the
    // file sidebar stops dragover for its own asset drops, so it never shows there first).
    const handleDragOver = (e: DragEvent) => {
      // Accept drops anywhere, or the browser would open a dropped file in place of the app.
      e.preventDefault();
      if (carriesDroppable(e)) {
        setIsDragging(true);
      }
    };

    // Every element the pointer crosses fires its own dragenter and dragleave (the new
    // element's enter before the old one's leave), so the drag has left the page once each
    // enter is matched by a leave. These run on window in the capture phase so that a child
    // which stops propagation (the file sidebar again) cannot hide the end of the drag and
    // leave the overlay up.
    const handleDragEnter = (e: DragEvent) => {
      if (carriesDroppable(e)) {
        enteredElementsRef.current += 1;
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      if (!carriesDroppable(e)) return;
      enteredElementsRef.current = Math.max(0, enteredElementsRef.current - 1);
      if (enteredElementsRef.current === 0) {
        setIsDragging(false);
      }
    };
    const endDrag = () => {
      enteredElementsRef.current = 0;
      setIsDragging(false);
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();

      // Handle file drops: a `.ne` plus optional sibling camera video / audio files.
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        await importNextEditorFile(Array.from(files));
      }

      // Handle URL drops
      const text = e.dataTransfer?.getData("text/plain");
      if (text && isNextEditorUrl(text)) {
        await fetchNextEditorFile(text).catch((error: unknown) => {
          console.error("Failed to load dropped URL:", error);
        });
      }
    };

    window.addEventListener("dragenter", handleDragEnter, true);
    window.addEventListener("dragleave", handleDragLeave, true);
    window.addEventListener("drop", endDrag, true);
    window.addEventListener("dragend", endDrag, true);
    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("drop", handleDrop);

    return () => {
      window.removeEventListener("dragenter", handleDragEnter, true);
      window.removeEventListener("dragleave", handleDragLeave, true);
      window.removeEventListener("drop", endDrag, true);
      window.removeEventListener("dragend", endDrag, true);
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("drop", handleDrop);
    };
  }, [fetchNextEditorFile, importNextEditorFile, isNextEditorUrl]);

  return { isDragging };
};
