import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import type { RuntimeDockLayout } from "../../hooks/useRuntimeDockLayout";
import type { RuntimeDockTab } from "../../types/runtime";
import { dockTabStateClassName } from "./runtimeDockHelpers";

export interface RuntimeDockTabConfig {
  id: RuntimeDockTab;
  label: string;
  icon: ReactNode;
}

/**
 * The runtime dock's tab strip. It takes the header's spare width and scrolls
 * sideways (scrollbar hidden; touch and trackpad still scroll it) once the tabs
 * outgrow it, so the full-height and collapse controls after it keep their
 * place and their 40px touch target on a narrow phone dock instead of being
 * clipped off the end of the header.
 */
const DOCK_TAB_STRIP_CLASS =
  "flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

interface RuntimeDockHeaderProps {
  tabs: readonly RuntimeDockTabConfig[];
  /** The tab on screen, which is marked as pressed. */
  activeTab: RuntimeDockTab;
  /** While a replay is on screen, the tabs and the collapse toggle are read-only. */
  disabled: boolean;
  onSelectTab: (tab: RuntimeDockTab) => void;
  layout: Pick<
    RuntimeDockLayout,
    "displayIsFullHeight" | "displayIsCollapsed" | "toggleFullHeight" | "toggleCollapsed"
  >;
  /** Each dock's own hooks on the collapse toggle: a tour step or a studio target. */
  collapseToggleAttributes?: Record<string, string>;
  /** More tabs, after the dock's own, inside the scrolling strip. */
  children?: ReactNode;
}

/**
 * The header row both runtime docks share: the tab strip, then the full-height
 * and collapse toggles. The product tour finds the collapse toggle of either
 * dock by its data-runtime-dock-toggle attribute.
 */
function RuntimeDockHeader({
  tabs,
  activeTab,
  disabled,
  onSelectTab,
  layout: { displayIsFullHeight, displayIsCollapsed, toggleFullHeight, toggleCollapsed },
  collapseToggleAttributes,
  children,
}: RuntimeDockHeaderProps) {
  return (
    <div className="flex items-center border-b border-[#11151d] bg-[#1e2129] px-2">
      {/* The tabs scroll sideways inside their own strip so the height and
          collapse controls after it stay on screen on a narrow phone dock. */}
      <div className={DOCK_TAB_STRIP_CLASS}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;

          return (
            <button
              key={tab.id}
              data-tour={tab.id === "agent" ? "agent" : undefined}
              type="button"
              aria-pressed={isActive}
              disabled={disabled}
              onClick={() => onSelectTab(tab.id)}
              className={`inline-flex items-center gap-2.5 border-r border-[#11151d] px-4 py-3 text-[13px] font-semibold transition-colors ${dockTabStateClassName(
                isActive,
              )} disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-slate-300`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}

        {children}
      </div>

      <button
        type="button"
        // The one dock control a viewer keeps during playback; their choice stays
        // on screen without reaching the recording (see useRuntimeDockLayout).
        disabled={displayIsCollapsed}
        onClick={toggleFullHeight}
        className="inline-flex shrink-0 items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:opacity-40 disabled:hover:text-slate-500"
        aria-label={
          displayIsFullHeight ? "Restore runtime dock height" : "Expand runtime dock to full height"
        }
        title={
          displayIsFullHeight ? "Restore runtime dock height" : "Expand runtime dock to full height"
        }
      >
        {displayIsFullHeight ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>

      <button
        type="button"
        data-runtime-dock-toggle=""
        {...collapseToggleAttributes}
        disabled={disabled}
        onClick={toggleCollapsed}
        className="inline-flex shrink-0 items-center justify-center text-slate-500 transition-colors hover:text-white size-10 disabled:cursor-default disabled:hover:text-slate-500"
        aria-label={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
        title={displayIsCollapsed ? "Expand runtime dock" : "Collapse runtime dock"}
      >
        {displayIsCollapsed ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    </div>
  );
}

export default RuntimeDockHeader;
