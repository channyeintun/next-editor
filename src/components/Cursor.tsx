import React from 'react';
import { useNextEditorMetadata, useLiveCursor } from '../hooks/useNextEditorContext';
import type { MouseCursorPosition } from '../core/src';
import IconCursor from './icon/IconCursor';

/**
 * Fake cursor component for playback visualization
 * Based on the working example from test-simple.sh
 */
interface FakeCursorProps {
  position: MouseCursorPosition & { hasParent?: boolean };
}

const FakeCursor: React.FC<FakeCursorProps> = ({ position }) => {
  if (!position.visible) return null;

  return (
    <div
      style={{
        position: position.hasParent ? 'absolute' : 'fixed',
        left: -7,
        top: -5,
        width: 24,
        height: 24,
        pointerEvents: 'none',
        zIndex: 9999,
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
      }}
    >
      <IconCursor width={24} height={24} />
    </div>
  );
};

/**
 * CursorComponent - Displays a fake cursor overlay during playback
 * Implementation based on working example from test-simple.sh
 */
const CursorComponent: React.FC<{
  hasParent?: boolean;
}> = (props) => {
  const { isPlaying } = useNextEditorMetadata();
  const currentCursor = useLiveCursor();

  // Render fake cursor during playback - fixed to viewport with smooth transitions
  return (
    <>
      {isPlaying && currentCursor && currentCursor.visible && (
        <FakeCursor position={currentCursor} {...props} />
      )}
    </>
  );
};

export default CursorComponent;