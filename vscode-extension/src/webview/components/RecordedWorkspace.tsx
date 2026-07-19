import { useEffect, useRef } from "react";
import type { TabDescriptor } from "../../model/events";
import type { PlaybackEngine } from "../player/PlaybackEngine";
import { UnsupportedSurface } from "./UnsupportedSurface";

function SurfaceView(props: { engine: PlaybackEngine; surfaceId: string; documentId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { engine, surfaceId, documentId } = props;

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      engine.attachSurface(surfaceId, documentId, container);
    }
    return () => engine.detachSurface(surfaceId);
  }, [engine, surfaceId, documentId]);

  return <div className="surface-view" ref={containerRef} />;
}

function GroupTabBar(props: { tabs: TabDescriptor[] }) {
  return (
    <div className="group-tabs">
      {props.tabs.map((tab) => (
        <span
          key={tab.tabId}
          className={tab.isActive ? "group-tab active" : "group-tab"}
          title={tab.label}
        >
          {tab.label}
        </span>
      ))}
    </div>
  );
}

// Reconstructed logical layout (plan §10.6): recorded group order and view
// columns, equal-sized groups, no invented pixel geometry.
export function RecordedWorkspace(props: { engine: PlaybackEngine }) {
  const { engine } = props;
  const topology = engine.reducer.state.topology;

  if (!topology || topology.groups.length === 0) {
    return <div className="workspace-empty">No recorded editor groups yet.</div>;
  }

  return (
    <div className="workspace">
      {topology.groups.map((group) => {
        const activeTab =
          group.tabs.find((tab) => tab.tabId === group.activeTabId) ?? group.tabs[0];
        let content = <div className="group-empty">Empty group</div>;
        if (activeTab) {
          if (
            activeTab.kind === "text" &&
            activeTab.documentId !== null &&
            engine.reducer.state.documents.has(activeTab.documentId)
          ) {
            const surfaceId = engine.surfaceForGroupDocument(group.groupId, activeTab.documentId);
            content = (
              <SurfaceView
                key={`${surfaceId}-${activeTab.documentId}`}
                engine={engine}
                surfaceId={surfaceId}
                documentId={activeTab.documentId}
              />
            );
          } else {
            content = <UnsupportedSurface kind={activeTab.kind} label={activeTab.label} />;
          }
        }
        return (
          <div key={group.groupId} className={group.isActive ? "group active" : "group"}>
            <GroupTabBar tabs={group.tabs} />
            <div className="group-content">{content}</div>
          </div>
        );
      })}
    </div>
  );
}
