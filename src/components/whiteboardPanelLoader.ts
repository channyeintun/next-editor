let whiteboardPanelPromise: ReturnType<typeof importWhiteboardPanel> | null = null;

function importWhiteboardPanel() {
  return import("./WhiteboardPanel");
}

/**
 * Share one import between React.lazy and Studio's preflight. Studio warms the
 * heavy Excalidraw chunk before the recording clock starts, so the first
 * whiteboard action doesn't disappear behind a cold module load.
 */
export function loadWhiteboardPanel() {
  whiteboardPanelPromise ??= importWhiteboardPanel();
  return whiteboardPanelPromise;
}
