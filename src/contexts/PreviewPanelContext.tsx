import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { PreviewPanelMode } from "../types/slides";
import { useNextEditorDomainAdapters } from "./NextEditorDomainAdaptersContext";

export const PREVIEW_DOCK_DEFAULT_WIDTH = 432;
export const PREVIEW_DOCK_MIN_WIDTH = 320;
export const PREVIEW_DOCK_MAX_WIDTH = 640;
const PREVIEW_DOCK_EDITOR_RESERVED_WIDTH = 480;

export function clampPreviewDockWidth(
  width: number,
  viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth,
): number {
  const maxWidth = Math.max(
    PREVIEW_DOCK_MIN_WIDTH,
    Math.min(PREVIEW_DOCK_MAX_WIDTH, viewportWidth - PREVIEW_DOCK_EDITOR_RESERVED_WIDTH),
  );

  return Math.min(maxWidth, Math.max(PREVIEW_DOCK_MIN_WIDTH, width));
}

function getDefaultPreviewDockWidth(): number {
  if (typeof window === "undefined") {
    return PREVIEW_DOCK_DEFAULT_WIDTH;
  }

  return clampPreviewDockWidth(window.innerWidth * 0.3, window.innerWidth);
}

interface PreviewPanelContextValue {
  isOpen: boolean;
  mode: PreviewPanelMode;
  isDocked: boolean;
  dockWidth: number;
  openPreview: (mode?: PreviewPanelMode) => void;
  closePreview: () => void;
  floatPreview: () => void;
  dockPreview: () => void;
  setDockWidth: (width: number) => void;
  togglePreview: () => void;
  applyPreviewPanelState: (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => void;
}

const PreviewPanelContext = createContext<PreviewPanelContextValue | null>(null);

interface PreviewPanelProviderProps {
  children: ReactNode;
}

export const PreviewPanelProvider = memo(function PreviewPanelProvider({
  children,
}: PreviewPanelProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<PreviewPanelMode>("docked");
  const [dockWidth, setDockWidthState] = useState(getDefaultPreviewDockWidth);
  const { preview } = useNextEditorDomainAdapters();

  const setDockWidth = useCallback((width: number) => {
    setDockWidthState(clampPreviewDockWidth(width));
  }, []);

  // Replay applies docked-preview resizes as offsets against the viewer's current
  // width (mirrors the file-sidebar). Registered here — not in the preview panel
  // component — so the offset still lands when the preview panel is closed.
  useEffect(() => {
    preview.setDockWidthDeltaApplier((delta) => {
      setDockWidthState((currentWidth) => clampPreviewDockWidth(currentWidth + delta));
    });
  }, [preview]);

  const openPreview = useCallback((nextMode?: PreviewPanelMode) => {
    if (nextMode) {
      setMode(nextMode);
    }

    setIsOpen(true);
  }, []);

  const closePreview = useCallback(() => {
    setIsOpen(false);
  }, []);

  const floatPreview = useCallback(() => {
    setMode("floating");
    setIsOpen(true);
  }, []);

  const dockPreview = useCallback(() => {
    setMode("docked");
    setIsOpen(true);
  }, []);

  const togglePreview = useCallback(() => {
    setIsOpen((current) => !current);
  }, []);

  useEffect(() => {
    const clampDockWidthToViewport = () => {
      setDockWidthState((currentWidth) => clampPreviewDockWidth(currentWidth));
    };

    window.addEventListener("resize", clampDockWidthToViewport);
    return () => window.removeEventListener("resize", clampDockWidthToViewport);
  }, []);

  const applyPreviewPanelState = useCallback(
    (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => {
      if (state.mode) {
        setMode(state.mode);
      }

      if (state.isOpen !== undefined) {
        setIsOpen(state.isOpen);
        return;
      }

      setIsOpen(true);
    },
    [],
  );

  const value = useMemo<PreviewPanelContextValue>(
    () => ({
      isOpen,
      mode,
      isDocked: isOpen && mode === "docked",
      dockWidth,
      openPreview,
      closePreview,
      floatPreview,
      dockPreview,
      setDockWidth,
      togglePreview,
      applyPreviewPanelState,
    }),
    [
      applyPreviewPanelState,
      closePreview,
      dockPreview,
      dockWidth,
      floatPreview,
      isOpen,
      mode,
      openPreview,
      setDockWidth,
      togglePreview,
    ],
  );

  return <PreviewPanelContext.Provider value={value}>{children}</PreviewPanelContext.Provider>;
});

export function usePreviewPanel(): PreviewPanelContextValue {
  const context = useContext(PreviewPanelContext);

  if (!context) {
    throw new Error("usePreviewPanel must be used inside PreviewPanelProvider");
  }

  return context;
}
