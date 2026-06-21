import { useEffect, useState } from "react";
import { useUrlLoader } from "./useUrlLoader";

export const useDragAndDropUrl = () => {
  const [isDragging, setIsDragging] = useState(false);
  const { fetchNextEditorFile, importNextEditorFile, isNextEditorUrl, isLoading } = useUrlLoader();

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();

      // Check if the drag contains text (URL) or files
      const hasText = e.dataTransfer?.types.includes("text/plain");
      const hasFiles = e.dataTransfer?.types.includes("Files");
      if (hasText || hasFiles) {
        setIsDragging(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      // Only hide drag indicator if we're leaving the document body
      if (e.target === document.body) {
        setIsDragging(false);
      }
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      // Handle file drops — accept a `.ne` plus an optional sibling camera video.
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const dropped = Array.from(files);
        const neFile = dropped.find(
          (file) => file.name.endsWith(".png") || file.name.endsWith(".ne"),
        );
        if (neFile) {
          const videoFile = dropped.find(
            (file) =>
              file !== neFile &&
              (file.type.startsWith("video/") || /\.(webm|mp4|mov)$/i.test(file.name)),
          );
          await importNextEditorFile(neFile, videoFile);
        }
      }

      // Handle URL drops
      const text = e.dataTransfer?.getData("text/plain");
      if (text && isNextEditorUrl(text)) {
        await fetchNextEditorFile(text).catch((error: unknown) => {
          console.error("Failed to load dropped URL:", error);
        });
      }
    };

    document.addEventListener("dragover", handleDragOver);
    document.addEventListener("dragleave", handleDragLeave);
    document.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("dragover", handleDragOver);
      document.removeEventListener("dragleave", handleDragLeave);
      document.removeEventListener("drop", handleDrop);
    };
  }, [fetchNextEditorFile, importNextEditorFile, isNextEditorUrl]);

  return { isDragging, isLoading };
};
