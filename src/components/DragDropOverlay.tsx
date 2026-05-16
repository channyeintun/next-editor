import React from 'react';

interface DragDropOverlayProps {
  isDragging: boolean;
  isLoading: boolean;
}

const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ isDragging, isLoading }) => {
  if (!isDragging && !isLoading) return null;

  const showDropTarget = isDragging && !isLoading;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-105">
      <div className={`${showDropTarget ? 'bg-gray-800 rounded-lg border-2 border-dashed border-blue-400 p-8' : ''} text-center`}>
        {isLoading ? (
          <div className="text-blue-400">
            <div className="animate-spin rounded-full border-b-2 border-blue-400 mx-auto size-12"></div>
          </div>
        ) : (
          <div className="text-blue-400">
            <p className="text-lg font-medium">Drop lesson file URL here</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DragDropOverlay;