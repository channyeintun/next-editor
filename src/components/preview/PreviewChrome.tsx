import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  MoreVertical,
  PanelRight,
  PictureInPicture2,
  RotateCw,
  SquareTerminal,
  X,
} from "lucide-react";
import type { PreviewPanelMode, PreviewSize } from "../../types/slides";
import type { PreviewActiveMode } from "./usePreviewController";
import { isCustomPreviewSize } from "./previewSizeUtils";

interface PreviewChromeProps {
  children: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
  size: PreviewSize;
  mode: PreviewPanelMode;
  dockWidth: number;
  /** Docked-only: whether the panel is at full width (false collapses it to 0). */
  dockExpanded?: boolean;
  /** Docked-only: enables the width transition during an open/close slide. */
  dockAnimating?: boolean;
  onClose: () => void;
  onFloat: () => void;
  onDock: () => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenConsole: () => void;
  onResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  onDockResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  onTransitionStart: () => void;
  onTransitionComplete: () => void;
  previewAddressLabel: string;
  previewAddressTitle: string;
  activeMode?: PreviewActiveMode;
  showModeToggle?: boolean;
  onModeChange?: (mode: PreviewActiveMode) => void;
}

function getFloatingStyle(size: PreviewSize): CSSProperties {
  if (isCustomPreviewSize(size)) {
    return {
      top: "5rem",
      right: "1.5rem",
      width: `${size.width}px`,
      height: `${size.height}px`,
      left: "auto",
      bottom: "auto",
    };
  }

  if (size === "large") {
    return {
      top: "5rem",
      right: "2rem",
      width: "min(44rem, calc(100vw - 4rem))",
      height: "min(38rem, calc(100vh - 7rem))",
      left: "auto",
      bottom: "auto",
    };
  }

  return {
    top: "5rem",
    right: "1.5rem",
    width: "min(28rem, calc(100vw - 3rem))",
    height: "min(34rem, calc(100vh - 7rem))",
    left: "auto",
    bottom: "auto",
  };
}

interface PreviewToolbarProps {
  mode: PreviewPanelMode;
  previewAddressLabel: string;
  previewAddressTitle: string;
  onClose: () => void;
  onFloat: () => void;
  onDock: () => void;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onOpenConsole: () => void;
  activeMode?: PreviewActiveMode;
  showModeToggle?: boolean;
  onModeChange?: (mode: PreviewActiveMode) => void;
}

function PreviewToolbar({
  mode,
  previewAddressLabel,
  previewAddressTitle,
  onClose,
  onFloat,
  onDock,
  onBack,
  onForward,
  onRefresh,
  isRefreshing,
  onOpenConsole,
  activeMode = "browser",
  showModeToggle = false,
  onModeChange,
}: PreviewToolbarProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [isMenuOpen]);

  const handleDockMode = () => {
    setIsMenuOpen(false);

    if (mode === "floating") {
      onDock();
      return;
    }

    onFloat();
  };

  const handleClose = () => {
    setIsMenuOpen(false);
    onClose();
  };

  return (
    <div className="shrink-0 border-b border-slate-800 bg-[#242938]">
      <div className="flex h-10.5 items-center gap-2 px-3">
        {showModeToggle && onModeChange ? (
          <div
            role="tablist"
            aria-label="Preview frame"
            className="inline-flex shrink-0 rounded-md bg-[#1a1e27] p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "browser"}
              onClick={() => onModeChange("browser")}
              className={`rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                activeMode === "browser"
                  ? "bg-slate-700 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Preview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeMode === "api"}
              onClick={() => onModeChange("api")}
              className={`rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                activeMode === "api"
                  ? "bg-slate-700 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              API
            </button>
          </div>
        ) : null}

        {activeMode === "browser" ? (
          <>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex size-5.5 shrink-0 items-center justify-center rounded-md text-slate-100 transition-colors hover:bg-slate-700 hover:text-white"
              aria-label="Go back in preview"
              title="Go back in preview"
            >
              <ArrowLeft size={18} />
            </button>

            <button
              type="button"
              onClick={onForward}
              className="inline-flex size-5.5 shrink-0 items-center justify-center rounded-md text-slate-100 transition-colors hover:bg-slate-700 hover:text-white"
              aria-label="Go forward in preview"
              title="Go forward in preview"
            >
              <ArrowRight size={18} />
            </button>

            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex size-5.5 shrink-0 items-center justify-center rounded-md text-slate-100 transition-colors hover:bg-slate-700 hover:text-white"
              aria-label="Refresh preview"
              title="Refresh preview"
            >
              <RotateCw size={16} className={isRefreshing ? "animate-spin" : undefined} />
            </button>

            <div
              className="flex h-6 min-w-0 flex-1 items-center rounded-lg border border-slate-950/70 bg-[#1e2430] px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
              title={previewAddressTitle}
              aria-label="Preview address"
            >
              <span className="truncate font-mono text-[13px] font-semibold leading-none text-slate-300">
                {previewAddressLabel}
              </span>
            </div>

            <button
              type="button"
              onClick={onOpenConsole}
              className="inline-flex size-6.5 shrink-0 items-center justify-center rounded-md border border-slate-800 bg-[#263346] text-sky-300 transition-colors hover:border-sky-500/60 hover:bg-[#2b3f58] hover:text-sky-100"
              aria-label="Open preview console"
              title="Open preview console"
            >
              <SquareTerminal size={16} />
            </button>
          </>
        ) : (
          <div className="flex-1" />
        )}

        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsMenuOpen((current) => !current);
            }}
            className="inline-flex items-center justify-center rounded-md text-slate-300 transition-colors hover:bg-slate-700 hover:text-white size-6.5"
            aria-label="Preview options"
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            title="Preview options"
          >
            <MoreVertical size={16} />
          </button>

          {isMenuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-full z-80 mt-2 w-44 rounded-lg border border-slate-700 bg-[#30343d] p-1 shadow-[0_18px_40px_rgba(2,6,23,0.45)]"
              onClick={(event) => event.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={handleDockMode}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
              >
                {mode === "floating" ? <PanelRight size={15} /> : <PictureInPicture2 size={15} />}
                {mode === "floating" ? "Unfloat" : "Float"}
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={handleClose}
                className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
              >
                <X size={15} />
                Close
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface PreviewResizeHandleProps {
  onResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
}

function PreviewResizeHandle({ onResizeStart }: PreviewResizeHandleProps) {
  return (
    <div
      onMouseDown={onResizeStart}
      onTouchStart={onResizeStart}
      onDoubleClick={(event) => event.stopPropagation()}
      className="absolute bottom-0 left-0 z-50 flex items-end justify-start cursor-sw-resize touch-none transition-colors group size-10"
      title="Resize preview"
    >
      <div className="mb-2 ml-2 flex flex-col items-start gap-0.5">
        <div className="h-[1.5px] w-5 origin-left rotate-45 bg-slate-400 opacity-40 transition-all group-hover:bg-blue-400 group-hover:opacity-100" />
        <div className="h-[1.5px] w-3.5 origin-left rotate-45 bg-slate-400 opacity-40 transition-all group-hover:bg-blue-400 group-hover:opacity-100" />
        <div className="h-[1.5px] w-2 origin-left rotate-45 bg-slate-400 opacity-40 transition-all group-hover:bg-blue-400 group-hover:opacity-100" />
      </div>

      <svg
        className="absolute bottom-0 left-0 -z-10 text-slate-600/30 transition-colors group-hover:text-blue-500/20 size-10"
        viewBox="0 0 40 40"
      >
        <path d="M0 40 L40 40 L0 0 Z" fill="currentColor" />
      </svg>
    </div>
  );
}

function DockedPreviewResizeHandle({ onResizeStart }: PreviewResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize preview"
      onMouseDown={onResizeStart}
      onTouchStart={onResizeStart}
      className="absolute inset-y-0 left-0 z-50 w-2 cursor-ew-resize touch-none group"
      title="Resize preview"
    >
      <div className="absolute inset-y-0 left-0 w-px bg-slate-900" />
      <div className="absolute inset-y-0 left-0 w-1 bg-sky-400/0 transition-colors group-hover:bg-sky-400/40" />
    </div>
  );
}

export function PreviewChrome({
  children,
  containerRef,
  size,
  mode,
  dockWidth,
  dockExpanded = true,
  dockAnimating = false,
  onClose,
  onFloat,
  onDock,
  onBack,
  onForward,
  onRefresh,
  isRefreshing,
  onOpenConsole,
  onResizeStart,
  onDockResizeStart,
  onTransitionStart,
  onTransitionComplete,
  previewAddressLabel,
  previewAddressTitle,
  activeMode,
  showModeToggle,
  onModeChange,
}: PreviewChromeProps) {
  const content = (
    <>
      <PreviewToolbar
        mode={mode}
        previewAddressLabel={previewAddressLabel}
        previewAddressTitle={previewAddressTitle}
        onClose={onClose}
        onFloat={onFloat}
        onDock={onDock}
        onBack={onBack}
        onForward={onForward}
        onRefresh={onRefresh}
        isRefreshing={isRefreshing}
        onOpenConsole={onOpenConsole}
        activeMode={activeMode}
        showModeToggle={showModeToggle}
        onModeChange={onModeChange}
      />

      <div className="relative min-h-0 flex-1 bg-white" data-cursor-replay-target="preview-content">
        {children}
        {mode === "floating" ? <PreviewResizeHandle onResizeStart={onResizeStart} /> : null}
      </div>
    </>
  );

  const isDocked = mode === "docked";
  const rootStyle = isDocked ? { width: dockExpanded ? dockWidth : 0 } : getFloatingStyle(size);
  const rootClassName = isDocked
    ? `relative z-30 flex h-full shrink-0 flex-col overflow-hidden border-l border-slate-900 bg-[#1d1f29]${
        dockAnimating
          ? " transition-[width] duration-200 ease-out motion-reduce:transition-none"
          : ""
      }`
    : "fixed z-60 flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-[#1d1f29] shadow-[0_24px_54px_rgba(2,6,23,0.52)] transition-[top,right,width,height,transform,opacity] duration-150 ease-out";

  return (
    <div
      role="complementary"
      aria-label="Preview"
      ref={containerRef}
      className={rootClassName}
      style={rootStyle}
      data-cursor-replay-target="preview"
      onTransitionStart={(event) => {
        if (event.target === event.currentTarget) {
          onTransitionStart();
        }
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget) {
          onTransitionComplete();
        }
      }}
    >
      {content}
      {isDocked ? <DockedPreviewResizeHandle onResizeStart={onDockResizeStart} /> : null}
    </div>
  );
}
