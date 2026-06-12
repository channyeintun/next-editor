import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
  TouchEvent as ReactTouchEvent,
} from "react";
import { AnimatePresence, motion, type Transition } from "motion/react";
import type { PreviewSize } from "../../types/slides";

interface PreviewChromeProps {
  children: ReactNode;
  containerRef: RefObject<HTMLDivElement | null>;
  size: PreviewSize;
  onClick: () => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onResizeStart: (event: ReactMouseEvent | ReactTouchEvent) => void;
  onTransitionStart: () => void;
  onTransitionComplete: () => void;
}

function getSizeClasses(size: PreviewSize): string {
  if (size === "large") {
    return "shadow-2xl border border-black/10 transition-shadow z-100";
  }

  if (size === "medium") {
    return "shadow-lg border border-gray-300 transition-shadow z-55";
  }

  return "shadow-md border border-gray-300 cursor-pointer transition-shadow z-55";
}

function getPreviewVariants(size: PreviewSize) {
  const base = {
    small: {
      top: "4rem",
      right: "1rem",
      width: "12rem",
      height: "8rem",
      left: "auto",
      bottom: "auto",
    },
    medium: {
      top: "5rem",
      right: "1rem",
      width: "20rem",
      height: "28rem",
      left: "auto",
      bottom: "auto",
    },
    large: {
      top: "10%",
      right: "10%",
      bottom: "10%",
      left: "10%",
      width: "80%",
      height: "80%",
    },
  };

  if (typeof size === "object") {
    return {
      ...base,
      custom: {
        top: "5rem",
        right: "1rem",
        width: `${size.width}px`,
        height: `${size.height}px`,
        left: "auto",
        bottom: "auto",
      },
    };
  }

  return base;
}

const springTransition: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 26,
  mass: 1,
};

const resizeTransition: Transition = {
  type: "tween",
  duration: 0,
};

export function PreviewChrome({
  children,
  containerRef,
  size,
  onClick,
  onMinimize,
  onMaximize,
  onResizeStart,
  onTransitionStart,
  onTransitionComplete,
}: PreviewChromeProps) {
  const isLarge = size === "large";
  const isSmall = size === "small";
  const isCustomSize = typeof size === "object";
  const variants = getPreviewVariants(size);
  const animateState = isCustomSize ? "custom" : size;

  return (
    <>
      <AnimatePresence>
        {isLarge ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-90 bg-black/10"
            onClick={onMinimize}
          />
        ) : null}
      </AnimatePresence>

      <motion.div
        variants={variants}
        initial={false}
        animate={animateState}
        transition={isCustomSize ? resizeTransition : springTransition}
        ref={containerRef}
        onAnimationStart={onTransitionStart}
        onAnimationComplete={onTransitionComplete}
        className={`fixed bg-white rounded-xl overflow-hidden flex flex-col ${getSizeClasses(size)} ${isSmall ? "hover:shadow-xl active:scale-95" : ""}`}
        onClick={(event) => {
          if (!isSmall) {
            return;
          }

          event.stopPropagation();
          onClick();
        }}
      >
        <div className="flex items-center bg-gray-50 px-3 py-2 border-b border-gray-200">
          <div className="flex items-center gap-1.5">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onMinimize();
              }}
              className="rounded-full bg-rose-400 hover:bg-rose-500 transition-colors flex items-center justify-center group size-3"
              title="Minimize"
            >
              <div className="rounded-full bg-rose-900/20 opacity-0 group-hover:opacity-100 size-1.5" />
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onMaximize();
              }}
              className="rounded-full bg-amber-400 hover:bg-amber-500 transition-colors flex items-center justify-center group size-3"
              title={isLarge ? "Medium Size" : "Maximize"}
            >
              <div className="rounded-full bg-amber-900/20 opacity-0 group-hover:opacity-100 size-1.5" />
            </button>
          </div>

          <div className="flex-1" />
        </div>

        <div className="relative flex-1">
          {children}

          <div
            onMouseDown={onResizeStart}
            onTouchStart={onResizeStart}
            onDoubleClick={(event) => event.stopPropagation()}
            className="absolute bottom-0 left-0 cursor-sw-resize flex items-end justify-start z-50 group transition-colors touch-none size-10"
            title="Drag to resize"
          >
            <div className="mb-2 ml-2 flex flex-col items-start gap-0.5">
              <div className="w-5 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-3.5 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
              <div className="w-2 h-[1.5px] bg-gray-400 group-hover:bg-blue-500 transform rotate-45 origin-left opacity-40 group-hover:opacity-100 transition-all" />
            </div>

            <svg
              className="absolute bottom-0 left-0 text-gray-200/50 group-hover:text-blue-500/20 transition-colors -z-10 size-10"
              viewBox="0 0 40 40"
            >
              <path d="M0 40 L40 40 L0 0 Z" fill="currentColor" />
            </svg>
          </div>
        </div>
      </motion.div>
    </>
  );
}
