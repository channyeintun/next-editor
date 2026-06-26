import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { PreviewPanelMode } from "../types/slides";
import { usePreviewAdapterHandle } from "./PreviewAdapterHandleContext";

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

export function PreviewPanelProvider({ children }: PreviewPanelProviderProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<PreviewPanelMode>("docked");
  const [dockWidth, setDockWidthState] = useState(getDefaultPreviewDockWidth);
  const previewHandle = usePreviewAdapterHandle();

  const setDockWidth = (width: number) => {
    setDockWidthState(clampPreviewDockWidth(width));
  };

  useEffect(() => {
    previewHandle.dockWidthDeltaApplier.current = (delta) => {
      setDockWidthState((currentWidth) => clampPreviewDockWidth(currentWidth + delta));
    };

    return () => {
      previewHandle.dockWidthDeltaApplier.current = null;
    };
  }, [previewHandle]);

  const openPreview = (nextMode?: PreviewPanelMode) => {
    if (nextMode) {
      setMode(nextMode);
    }

    setIsOpen(true);
  };

  const closePreview = () => {
    setIsOpen(false);
  };

  const floatPreview = () => {
    setMode("floating");
    setIsOpen(true);
  };

  const dockPreview = () => {
    setMode("docked");
    setIsOpen(true);
  };

  const togglePreview = () => {
    setIsOpen((current) => !current);
  };

  useEffect(() => {
    const clampDockWidthToViewport = () => {
      setDockWidthState((currentWidth) => clampPreviewDockWidth(currentWidth));
    };

    window.addEventListener("resize", clampDockWidthToViewport);
    return () => window.removeEventListener("resize", clampDockWidthToViewport);
  }, []);

  const applyPreviewPanelState = (state: { isOpen?: boolean; mode?: PreviewPanelMode }) => {
    if (state.mode) {
      setMode(state.mode);
    }

    if (state.isOpen !== undefined) {
      setIsOpen(state.isOpen);
      return;
    }

    setIsOpen(true);
  };

  const value: PreviewPanelContextValue = {
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
  };

  return <PreviewPanelContext.Provider value={value}>{children}</PreviewPanelContext.Provider>;
}

export function usePreviewPanel(): PreviewPanelContextValue {
  const context = useContext(PreviewPanelContext);

  if (!context) {
    throw new Error("usePreviewPanel must be used inside PreviewPanelProvider");
  }

  return context;
}
