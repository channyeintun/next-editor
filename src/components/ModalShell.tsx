import type { ReactNode } from "react";

interface ModalShellProps {
  /** How wide the card may grow. */
  maxWidthClassName: "max-w-md" | "max-w-xl";
  /** Called for a click on the backdrop; a click inside the card never reaches it. */
  onBackdropClick: () => void;
  children: ReactNode;
}

/**
 * The dimmed, blurred full-screen backdrop and the centered card that the
 * editor's settings dialogs are drawn in.
 */
export default function ModalShell({
  maxWidthClassName,
  onBackdropClick,
  children,
}: ModalShellProps) {
  return (
    <div
      className="fixed inset-0 z-50 bg-[#0b0d12]/62 px-4 py-8 backdrop-blur-[2px]"
      onClick={onBackdropClick}
    >
      <div
        className={`mx-auto flex max-h-full w-full ${maxWidthClassName} flex-col overflow-hidden rounded-2xl border border-slate-800 bg-[#151821] shadow-[0_24px_48px_rgba(2,6,23,0.55)]`}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
