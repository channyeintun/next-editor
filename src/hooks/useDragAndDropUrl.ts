import { useEffect, useState } from 'react';
import { useScrimbaUrlLoader } from './useScrimbaUrlLoader';

export const useDragAndDropUrl = () => {
  const [isDragging, setIsDragging] = useState(false);
  const { fetchScrimbaFile, isScrimbaUrl, isLoading } = useScrimbaUrlLoader();

  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();

      // Check if the drag contains text (URL)
      const hasText = e.dataTransfer?.types.includes('text/plain');
      if (hasText) {
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

      const text = e.dataTransfer?.getData('text/plain');
      if (text && isScrimbaUrl(text)) {
        await fetchScrimbaFile(text).catch(error => {
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
  }, [fetchScrimbaFile, isScrimbaUrl]);

  return { isDragging, isLoading };
};