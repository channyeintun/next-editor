import { Check } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismissOnOutsideInteraction } from "../../hooks/useDismissOnOutsideInteraction";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  CONTEXT_MENU_FALLBACK_HEIGHT,
  CONTEXT_MENU_FALLBACK_WIDTH,
  getViewportClampedContextMenuPlacement,
} from "./contextMenuPlacement";
import type { SidebarContextMenuState, SidebarEntryKind } from "./sidebarModel";

const MENU_ITEM_CLASS =
  "flex w-full items-center px-4 py-2 text-sm text-slate-200 transition-colors hover:bg-slate-800";

interface FileContextMenuProps {
  /** The entry the menu was opened on, and where; null while it is closed. */
  menu: SidebarContextMenuState | null;
  /** Offer "Open in Preview" (an HTML file, outside React lessons). */
  canOpenInPreview: boolean;
  /** The entry is the file the preview shows. */
  isInPreview: boolean;
  /** Deleting the entry would leave the project without a file. */
  isDeleteRefused: boolean;
  onDismiss: () => void;
  onCreate: (kind: SidebarEntryKind, parentPath: string) => void;
  onUpload: (parentPath: string) => void;
  onOpenInPreview: (path: string) => void;
  onRename: (kind: SidebarEntryKind, path: string) => void;
  onDelete: (kind: SidebarEntryKind, path: string) => void;
}

/**
 * The file sidebar's right-click menu, kept inside the viewport. The sidebar
 * renders it for as long as the sidebar is mounted, so the menu's last measured
 * size carries over to the next opening, as it did when the sidebar held it.
 *
 * It sits after the whole tree in the DOM, so opening it moves focus to its
 * first item, and tabbing out of it closes it; the sidebar then hands focus
 * back to the row it was opened from when nothing else took it.
 */
export default function FileContextMenu({
  menu,
  canOpenInPreview,
  isInPreview,
  isDeleteRefused,
  onDismiss,
  onCreate,
  onUpload,
  onOpenInPreview,
  onRename,
  onDelete,
}: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);
  const [menuSize, setMenuSize] = useState({
    width: CONTEXT_MENU_FALLBACK_WIDTH,
    height: CONTEXT_MENU_FALLBACK_HEIGHT,
  });

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) {
      return;
    }

    const element = menuRef.current;
    const bounds = element.getBoundingClientRect();
    const nextSize = {
      width: bounds.width || CONTEXT_MENU_FALLBACK_WIDTH,
      height: element.scrollHeight || bounds.height || CONTEXT_MENU_FALLBACK_HEIGHT,
    };

    setMenuSize((currentSize) => {
      if (currentSize.width === nextSize.width && currentSize.height === nextSize.height) {
        return currentSize;
      }

      return nextSize;
    });
  }, [menu, canOpenInPreview]);

  useEffect(() => {
    if (menu) {
      firstItemRef.current?.focus({ preventScroll: true });
    }
  }, [menu]);

  useDismissOnOutsideInteraction({
    isOpen: menu !== null,
    containerRef: menuRef,
    onDismiss,
    dismissOnEscape: true,
    listenOn: "window",
  });

  // Worked out inside `menu ?` on purpose: the compiler then recomputes it for
  // every new menu object, reading the viewport size afresh, rather than only
  // when the anchor coordinates change.
  const placement = menu
    ? getViewportClampedContextMenuPlacement({
        anchorX: menu.x,
        anchorY: menu.y,
        menuWidth: menuSize.width,
        menuHeight: menuSize.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
    : undefined;

  if (!menu || !placement) {
    return null;
  }

  // A folder's new entries go inside it; a file's go next to it.
  const createParentPath = menu.kind === "folder" ? menu.path : menu.parentPath;

  return (
    <div
      ref={menuRef}
      role="group"
      aria-label={menu.kind === "folder" ? "Folder actions" : "File actions"}
      onBlur={(event) => {
        // A null relatedTarget is ignored: Safari does not focus a button on
        // mousedown, so a click on an item blurs to nothing before it fires.
        // Pointer-downs outside the menu are dismissed by the hook above.
        const next = event.relatedTarget as Node | null;
        if (next && !event.currentTarget.contains(next)) {
          onDismiss();
        }
      }}
      // Windows sends the Menu key's contextmenu on keyup, after this menu has
      // taken focus; without this the browser's own menu opens over it.
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-60 min-w-56 overflow-y-auto rounded-xl border border-slate-700 bg-[#1b2029] py-2 shadow-[0_20px_40px_rgba(2,6,23,0.55)]"
      style={{
        left: placement.left,
        top: placement.top,
        maxHeight: placement.maxHeight,
      }}
    >
      <button
        ref={firstItemRef}
        type="button"
        onClick={() => onCreate("file", createParentPath)}
        className={MENU_ITEM_CLASS}
      >
        New File
      </button>
      <button
        type="button"
        onClick={() => onCreate("folder", createParentPath)}
        className={MENU_ITEM_CLASS}
      >
        New Folder
      </button>
      <button type="button" onClick={() => onUpload(createParentPath)} className={MENU_ITEM_CLASS}>
        Upload Files Here
      </button>
      {canOpenInPreview ? (
        // The file already in the preview is marked by a check and aria-current,
        // not by its colour alone.
        <button
          type="button"
          aria-current={isInPreview ? "true" : undefined}
          onClick={() => onOpenInPreview(menu.path)}
          className={`flex w-full items-center px-4 py-2 text-sm transition-colors ${
            isInPreview ? "text-sky-200 hover:bg-slate-800" : "text-slate-200 hover:bg-slate-800"
          }`}
        >
          Open in Preview
          {isInPreview ? <Check size={14} className="ml-auto text-sky-200" /> : null}
        </button>
      ) : null}
      <div className="my-2 border-t border-slate-700" />
      <button
        type="button"
        onClick={() => {
          void copyTextToClipboard(`/${menu.path}`);
          onDismiss();
        }}
        className={MENU_ITEM_CLASS}
      >
        Copy Path
      </button>
      <button
        type="button"
        onClick={() => {
          void copyTextToClipboard(menu.path);
          onDismiss();
        }}
        className={MENU_ITEM_CLASS}
      >
        Copy Relative Path
      </button>
      <div className="my-2 border-t border-slate-700" />
      <button
        type="button"
        onClick={() => onRename(menu.kind, menu.path)}
        className={MENU_ITEM_CLASS}
      >
        Rename
      </button>
      <button
        type="button"
        disabled={isDeleteRefused}
        title={isDeleteRefused ? "A project needs at least one file" : undefined}
        onClick={() => onDelete(menu.kind, menu.path)}
        className="flex w-full items-center px-4 py-2 text-sm text-rose-200 transition-colors hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:text-slate-500 disabled:hover:bg-transparent"
      >
        {menu.kind === "folder" ? "Delete Folder" : "Delete File"}
      </button>
      {isDeleteRefused ? (
        <p className="px-4 pb-1 text-xs text-slate-300">A project needs at least one file</p>
      ) : null}
    </div>
  );
}
