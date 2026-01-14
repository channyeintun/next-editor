import { useEffect, useState } from 'react';
import { useScrimbaUrlLoader } from './useScrimbaUrlLoader';

export const useDragAndDropUrl = () => {
  const [isDragging, setIsDragging] = useState(false);
  const { fetchScrimbaFile, importScrimbaFile, isScrimbaUrl, isLoading } = useScrimbaUrlLoader();

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();

      // Check if the drag contains text (URL) or files
      const hasText = e.dataTransfer?.types.includes('text/plain');
      const hasFiles = e.dataTransfer?.types.includes('Files');
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

      // Handle file drops
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.name.endsWith('.png') || file.name.endsWith('.scrimba') || file.name.endsWith('.webm') || file.name.endsWith('.mp4')) {
          await importScrimbaFile(file);
        }
      }

      // Handle URL drops
      const text = e.dataTransfer?.getData('text/plain');
      if (text && isScrimbaUrl(text)) {
        await fetchScrimbaFile(text).catch((error: unknown) => {
          console.error('Failed to load dropped URL:', error);
        });
      }
    };

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [fetchScrimbaFile, importScrimbaFile, isScrimbaUrl]);

  return { isDragging, isLoading };
};