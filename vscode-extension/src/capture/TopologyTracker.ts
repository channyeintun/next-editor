import * as vscode from "vscode";
import type {
  GroupSnapshot,
  TabDescriptor,
  TabKind,
  TopologySnapshotPayload,
} from "../model/events";
import { newGroupId, newTabId, type DocumentId, type GroupId, type TabId } from "../model/ids";
import { resourceKeyOf, type DocumentRegistry } from "./DocumentRegistry";

export function classifyTabInput(tab: vscode.Tab): {
  kind: TabKind;
  resourceKey: string | null;
} {
  const input = tab.input;
  if (input instanceof vscode.TabInputText) {
    return { kind: "text", resourceKey: resourceKeyOf(input.uri) };
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return { kind: "textDiff", resourceKey: resourceKeyOf(input.modified) };
  }
  if (input instanceof vscode.TabInputNotebook) {
    return { kind: "notebook", resourceKey: resourceKeyOf(input.uri) };
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    return { kind: "notebookDiff", resourceKey: null };
  }
  if (input instanceof vscode.TabInputCustom) {
    return { kind: "custom", resourceKey: resourceKeyOf(input.uri) };
  }
  if (input instanceof vscode.TabInputWebview) {
    return { kind: "webview", resourceKey: null };
  }
  if (input instanceof vscode.TabInputTerminal) {
    return { kind: "terminal", resourceKey: null };
  }
  return { kind: "other", resourceKey: null };
}

const UNSUPPORTED_KINDS: ReadonlySet<TabKind> = new Set([
  "textDiff",
  "notebook",
  "notebookDiff",
  "custom",
  "webview",
  "terminal",
  "other",
]);

// Structural identity key used when object identity misses (plan §8.7).
function structuralKeyOf(tab: vscode.Tab): string {
  const { kind, resourceKey } = classifyTabInput(tab);
  return `${kind}|${resourceKey ?? ""}|${tab.label}`;
}

type KnownTab = { tabId: TabId; structuralKey: string; groupId: GroupId };

export type TopologyResult = {
  payload: TopologySnapshotPayload;
  newUnsupported: { tabId: TabId; kind: TabKind; label: string }[];
  changed: boolean;
};

export class TopologyTracker {
  private readonly groupIds = new WeakMap<vscode.TabGroup, GroupId>();
  private readonly tabIds = new WeakMap<vscode.Tab, TabId>();
  private knownTabs = new Map<TabId, KnownTab>();
  private knownGroupColumns = new Map<GroupId, number>();
  private readonly announcedUnsupported = new Set<TabId>();
  private lastSnapshotKey: string | null = null;

  /**
   * Reconcile the live tab/group state into a coherent snapshot. Weak object
   * identity first; structural matching as fallback; unambiguous or bust —
   * an ambiguous match allocates fresh IDs and flags a discontinuity.
   */
  snapshot(documents: DocumentRegistry): TopologyResult {
    let discontinuity = false;
    const groups: GroupSnapshot[] = [];
    const newUnsupported: TopologyResult["newUnsupported"] = [];
    const nextKnownTabs = new Map<TabId, KnownTab>();
    const nextGroupColumns = new Map<GroupId, number>();
    const claimedTabIds = new Set<TabId>();
    const claimedGroupIds = new Set<GroupId>();

    // Pass 1: weak identity claims.
    const liveGroups = [...vscode.window.tabGroups.all].sort((a, b) => a.viewColumn - b.viewColumn);
    for (const group of liveGroups) {
      const existing = this.groupIds.get(group);
      if (existing) {
        claimedGroupIds.add(existing);
      }
      for (const tab of group.tabs) {
        const tabId = this.tabIds.get(tab);
        if (tabId) {
          claimedTabIds.add(tabId);
        }
      }
    }

    let activeGroupId: GroupId | null = null;

    for (const group of liveGroups) {
      let groupId = this.groupIds.get(group);
      if (!groupId) {
        // Structural fallback: an unclaimed known group with this column.
        const candidates = [...this.knownGroupColumns.entries()].filter(
          ([id, column]) => !claimedGroupIds.has(id) && column === group.viewColumn,
        );
        if (candidates.length === 1 && candidates[0]) {
          groupId = candidates[0][0];
        } else {
          if (candidates.length > 1) {
            discontinuity = true;
          }
          groupId = newGroupId();
        }
        this.groupIds.set(group, groupId);
        claimedGroupIds.add(groupId);
      }
      nextGroupColumns.set(groupId, group.viewColumn);
      if (group.isActive) {
        activeGroupId = groupId;
      }

      const tabs: TabDescriptor[] = [];
      let activeTabId: TabId | null = null;
      for (const tab of group.tabs) {
        let tabId = this.tabIds.get(tab);
        const structuralKey = structuralKeyOf(tab);
        if (!tabId) {
          const candidates = [...this.knownTabs.entries()].filter(
            ([id, known]) => !claimedTabIds.has(id) && known.structuralKey === structuralKey,
          );
          if (candidates.length === 1 && candidates[0]) {
            tabId = candidates[0][0];
          } else {
            if (candidates.length > 1) {
              discontinuity = true;
            }
            tabId = newTabId();
          }
          this.tabIds.set(tab, tabId);
          claimedTabIds.add(tabId);
        }
        nextKnownTabs.set(tabId, { tabId, structuralKey, groupId });

        const { kind, resourceKey } = classifyTabInput(tab);
        let documentId: DocumentId | null = null;
        if (kind === "text" && resourceKey) {
          const uri = (tab.input as vscode.TabInputText).uri;
          documentId = documents.getByUri(uri)?.documentId ?? null;
        }
        const descriptor: TabDescriptor = {
          tabId,
          kind,
          documentId,
          label: tab.label,
          isActive: tab.isActive,
          isPinned: tab.isPinned,
          isPreview: tab.isPreview,
        };
        tabs.push(descriptor);
        if (tab.isActive) {
          activeTabId = tabId;
        }
        if (UNSUPPORTED_KINDS.has(kind) && !this.announcedUnsupported.has(tabId)) {
          this.announcedUnsupported.add(tabId);
          newUnsupported.push({ tabId, kind, label: tab.label });
        }
      }

      groups.push({
        groupId,
        viewColumn: group.viewColumn,
        isActive: group.isActive,
        activeTabId,
        tabs,
      });
    }

    this.knownTabs = nextKnownTabs;
    this.knownGroupColumns = nextGroupColumns;

    const payload: TopologySnapshotPayload = {
      groups,
      activeGroupId,
      fidelity: "reconstructed-no-geometry",
      discontinuity,
    };

    // Deduplicate identical consecutive snapshots (plan §8.8).
    const snapshotKey = JSON.stringify(payload);
    const changed = snapshotKey !== this.lastSnapshotKey;
    if (changed) {
      this.lastSnapshotKey = snapshotKey;
    }
    return { payload, newUnsupported, changed };
  }
}
