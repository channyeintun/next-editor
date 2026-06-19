import React from "react";

interface DragDropOverlayProps {
  isDragging: boolean;
}

const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ isDragging }) => {
  if (!isDragging) return null;

  return (
    // pointer-events-none lets drag/drop pass through to the elements beneath
    // (e.g. the file sidebar handles asset drops; the document handles URL/.ne
    // drops) instead of this purely-visual hint capturing every drop.
    <div className="pointer-events-none fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-105">
      <div className="bg-gray-800 rounded-lg border-2 border-dashed border-blue-400 p-8 text-center">
        <div className="text-blue-400">
          <p className="text-lg font-medium">Drop lesson file URL here</p>
        </div>
      </div>
    </div>
  );
};

export default DragDropOverlay;
