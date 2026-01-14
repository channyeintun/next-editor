import React from 'react';

interface DragDropOverlayProps {
  isDragging: boolean;
  isLoading: boolean;
}

const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ isDragging, isLoading }) => {
  if (!isDragging && !isLoading) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-gray-800 border-2 border-dashed border-blue-400 rounded-lg p-8 text-center">
        {isLoading ? (
          <div className="text-blue-400">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mx-auto"></div>

          </div>
        ) : (
          <div className="text-blue-400">
            <p className="text-lg font-medium">Drop .scrimba file URL here</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DragDropOverlay;