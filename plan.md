# Preview Patch/Diff Record and Replay Implementation Plan

## Purpose

Improve Next Editor preview recording and replay by replacing full-preview HTML snapshots as the normal recorded preview state with DOM patch records captured from the live preview document.

The goal is to keep the current no-flash replay behavior while making preview replay more granular, more storage-efficient for browser/runtime changes, and closer to Scrimba's DOM mutation action model.

This plan is intentionally only a plan. It does not implement code.

## Current State

Next Editor already has a working preview recording and playback system.

Current preview behavior is split across these surfaces:

- `src/contexts/webContainerRuntimeSupport.ts`
  - Injects runtime support into the preview page.
  - Uses a `MutationObserver` today, but only to trigger full `document.documentElement.outerHTML` snapshot messages.
- `src/components/preview/usePreviewMessageBridge.ts`
  - Receives preview messages from the iframe.
  - Converts runtime HTML snapshots into replayable preview content.
  - Emits semantic preview events such as `preview_refresh`, `preview_route_change`, `preview_scroll`, and `preview_interaction`.
- `src/components/preview/previewIframeUtils.ts`
  - Contains the current in-place preview HTML patching utilities.
  - This is why replay can already avoid obvious full iframe flashing.
- `src/components/preview/usePreviewPlaybackRegistration.ts`
  - Registers preview snapshot getter/applier behavior.
  - Applies preview content into the persistent preview iframe.
  - Replays interaction effects such as focus, input value, scroll, and click feedback.
- `src/core/src/machine/editorMachine.ts`
  - Orchestrates recording and playback through XState.
  - Records editor frames separately from preview-domain events.

The important distinction to preserve:

- Editor frames describe editor-side state over time.
- Preview events describe preview-domain semantic events over time.
- Preview patch records should describe DOM evolution inside the preview document over time.

## Goals

1. Keep the existing replay UX: one persistent replay iframe with no visible flash.
2. Record preview DOM changes as normalized patch records instead of using full HTML snapshots as the common path.
3. Use the live page `MutationObserver` as the primary diff source.
4. Use direct DOM operations for small patch application.
5. Use `morphdom` as an in-place reconciliation engine for coarse subtree replacement or recovery cases.
6. Preserve semantic preview events as separate timeline events.
7. Treat route changes as logical preview metadata plus DOM patches, not as iframe navigation during replay.
8. Keep backwards compatibility with existing recordings that only contain full preview content snapshots.

## Non-Goals

1. Do not introduce interval checkpoints.
2. Do not hard-replace the preview document during normal replay.
3. Do not reload or navigate the replay iframe for route changes.
4. Do not merge preview patch records into editor frames.
5. Do not make `morphdom` define the persisted recording format.
6. Do not replace existing semantic preview events such as `preview_refresh`, `preview_scroll`, or `preview_interaction`.
7. Do not implement Scrimba's exact protocol or opcode format.

## Proposed Architecture

The preview replay system should become a three-layer model:

1. Semantic preview timeline
   - Existing `PreviewEvent` stream remains responsible for user/runtime meaning.
   - Examples: run/save refresh boundary, route change, scroll, click/focus/input interaction.

2. Preview DOM patch timeline
   - New patch records describe how the preview DOM changed at a given recording time.
   - These records are sourced from the live preview page's `MutationObserver`.

3. Replay apply engine
   - Applies patches into a persistent replay iframe.
   - Uses direct DOM operations for precise mutations.
   - Uses `morphdom` only when a subtree must be reconciled from serialized HTML.

High-level flow:

```text
Live preview iframe
  -> injected recorder script
  -> MutationObserver records
  -> normalized PreviewDomPatchBatch messages
  -> parent message bridge
  -> recording session patch stream
  -> replay cursor applies patch batches
  -> persistent replay iframe DOM updates in place
```

## Data Model

Add a new persisted preview patch stream beside existing preview events.

Suggested top-level recording addition:

```ts
type Recording = {
  // existing fields
  previewEvents?: PreviewEvent[];

  // new field
  previewPatchBatches?: PreviewDomPatchBatch[];
};
```

The patch stream should be versioned independently so the format can evolve without forcing the whole recording version to change for small preview-patch refinements.

```ts
type PreviewDomPatchBatch = {
  version: 1;
  time: number;
  source: "runtime-preview" | "static-preview";
  documentId: string;
  baseRevision: number;
  revision: number;
  route?: string;
  ops: PreviewDomPatchOp[];
};
```

Field intent:

- `time`: recording-relative time, same timeline basis as existing preview events.
- `source`: whether the patch came from the runtime preview or static preview path.
- `documentId`: stable identity for the current logical preview document session.
- `baseRevision`: previous DOM revision expected by this batch.
- `revision`: DOM revision after this batch.
- `route`: optional logical route metadata; replay must not navigate for it.
- `ops`: ordered DOM operations.

Patch operations:

```ts
type PreviewDomPatchOp =
  | PreviewSetTextOp
  | PreviewSetAttributeOp
  | PreviewRemoveAttributeOp
  | PreviewInsertNodeOp
  | PreviewRemoveNodeOp
  | PreviewMoveNodeOp
  | PreviewReplaceSubtreeOp
  | PreviewSetPropertyOp;
```

Suggested operation shapes:

```ts
type PreviewNodeRef = {
  id?: string;
  path: number[];
};

type SerializedPreviewNode = {
  kind: "element" | "text" | "comment" | "doctype";
  tagName?: string;
  namespaceURI?: string | null;
  attributes?: Array<[string, string]>;
  text?: string;
  children?: SerializedPreviewNode[];
};

type PreviewSetTextOp = {
  op: "set_text";
  target: PreviewNodeRef;
  text: string;
};

type PreviewSetAttributeOp = {
  op: "set_attribute";
  target: PreviewNodeRef;
  name: string;
  value: string;
  namespaceURI?: string | null;
};

type PreviewRemoveAttributeOp = {
  op: "remove_attribute";
  target: PreviewNodeRef;
  name: string;
  namespaceURI?: string | null;
};

type PreviewInsertNodeOp = {
  op: "insert_node";
  parent: PreviewNodeRef;
  index: number;
  node: SerializedPreviewNode;
};

type PreviewRemoveNodeOp = {
  op: "remove_node";
  target: PreviewNodeRef;
};

type PreviewMoveNodeOp = {
  op: "move_node";
  target: PreviewNodeRef;
  parent: PreviewNodeRef;
  index: number;
};

type PreviewReplaceSubtreeOp = {
  op: "replace_subtree";
  target: PreviewNodeRef;
  html: string;
  mode: "children" | "node";
};

type PreviewSetPropertyOp = {
  op: "set_property";
  target: PreviewNodeRef;
  name: "value" | "checked" | "selected";
  value: string | boolean;
};
```

Node identity rules:

- Prefer stable generated node ids when possible.
- Keep path fallback for nodes without stable ids.
- Paths are child indexes from `document.documentElement` or another agreed root.
- Generated ids must not be visible to application code as regular attributes unless there is no better option.
- If marker attributes are needed, use a private name and strip or ignore them in recorded serialized HTML.

## Recording Pipeline

### 1. Add an injected preview patch recorder

Extend the existing injected runtime support script so it can emit patch batches instead of full HTML snapshots as the normal path.

Responsibilities inside the iframe:

1. Assign stable identities to observed nodes.
2. Observe DOM changes with `MutationObserver`.
3. Normalize browser `MutationRecord` objects into serializable patch operations.
4. Coalesce synchronous mutation bursts into one batch per microtask or animation frame.
5. Emit patch batches to the parent with recording-relative timing metadata.

The observer should include:

```ts
{
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
  attributeOldValue: false,
  characterDataOldValue: false
}
```

Old values are not required for forward replay. Avoid storing them unless reverse replay of the preview DOM becomes a concrete goal.

### 2. Normalize mutation records

Map raw mutation records to patch operations:

- `characterData` -> `set_text`
- `attributes` with value present -> `set_attribute`
- `attributes` with value missing -> `remove_attribute`
- `childList.addedNodes` -> `insert_node` or `move_node`
- `childList.removedNodes` -> `remove_node`
- large or ambiguous child-list changes -> `replace_subtree`

Normalization should happen before sending to the parent so the parent records a stable, app-owned format rather than browser-specific `MutationRecord` details.

### 3. Coalesce noisy changes

Coalescing rules:

- Multiple text changes to the same node in one flush become one `set_text`.
- Multiple attribute writes to the same attribute in one flush keep only the final value.
- Insert followed by remove in the same flush is dropped when it has no visible final effect.
- Remove followed by insert of the same node becomes `move_node` when identity is reliable.
- Many sibling operations under the same parent can become one `replace_subtree` for that parent.

The first version should prefer correctness and no flash over maximum compression.

### 4. Keep semantic preview events separate

Do not convert existing preview events into patch operations.

Examples:

- `preview_refresh` remains the semantic boundary for Run/Cmd+S or equivalent refresh behavior.
- `preview_route_change` remains route metadata.
- `preview_scroll` remains viewport scroll state.
- `preview_interaction` remains interaction replay state.

The patch stream records what happened to the DOM around those events.

### 5. Initial document seed

A replay iframe still needs an initial DOM before patch batches can apply.

Use one initial seed at recording start or preview-session start:

```ts
type PreviewInitialDocument = {
  version: 1;
  time: number;
  documentId: string;
  route?: string;
  html: string;
};
```

This is not an interval checkpoint. It is the starting document for a logical preview document session.

After the initial seed, normal replay should advance through patch batches.

### 6. Recovery snapshots only for explicit boundaries

Allow a full subtree or document seed only at explicit semantic boundaries, not on a timer.

Acceptable boundaries:

- Recording start.
- Runtime preview becomes available for the first time.
- User-triggered Run/Cmd+S preview refresh boundary.
- Severe patch desynchronization recovery during recording or replay.

Even at these boundaries, replay should pre-seed or reconcile in place so the user does not see iframe flashing.

## Parent Message Bridge

Add a new preview message type for patch batches, for example:

```ts
type PreviewDomPatchMessage = {
  type: "NEXT_EDITOR_RUNTIME_PATCH_BATCH";
  payload: PreviewDomPatchBatch;
};
```

Bridge responsibilities:

1. Validate the message shape.
2. Attach or verify recording-relative time.
3. Append the batch to the recording session.
4. Preserve existing handling for full snapshot messages as compatibility/fallback.
5. Avoid emitting `preview_refresh` merely because DOM changed.

The bridge should treat DOM patch batches as preview state evolution, not as semantic preview actions.

## Replay Pipeline

### 1. Create the replay iframe once

Replay should continue to use one persistent iframe for the preview playback session.

Before the iframe is shown for playback:

1. Load the initial replay document seed.
2. Install any replay-only helpers needed for interaction effects.
3. Apply patch batches up to the starting playback time if seeking into the middle.
4. Show the iframe only after it is internally ready.

### 2. Apply patch batches by timeline time

During playback:

1. Find patch batches whose `time` is at or before the current playback time.
2. Apply batches in revision order.
3. Apply each operation in order inside the persistent iframe document.
4. Apply semantic preview events independently through the existing preview event replay path.

The replay cursor should track:

- Current `documentId`.
- Current applied patch `revision`.
- Last applied patch batch index.
- Current route metadata.

### 3. Seeking behavior

For seeking backward or jumping forward:

1. Start from the nearest available initial document seed before the target time.
2. Apply patch batches forward until the target time.
3. Apply semantic preview events up to the target time.

Because interval checkpoints are not desired, the first version can accept slower long-distance seeks for preview DOM state. Later optimization can add explicit semantic-boundary seeds only, still avoiding timer-based checkpoints.

### 4. Route changes

Route changes should not navigate the replay iframe.

Replay behavior:

- Update route metadata in the preview state.
- Apply DOM patches caused by the route change.
- Apply scroll/focus/interaction events separately.
- Keep the same iframe document alive unless a new explicit document seed is required.

## Apply Engine

### Direct operations first

Use direct DOM operations for precise patch ops:

- `set_text`: set `node.nodeValue`.
- `set_attribute`: call `setAttribute` or `setAttributeNS`.
- `remove_attribute`: call `removeAttribute` or `removeAttributeNS`.
- `insert_node`: deserialize and insert at the requested index.
- `remove_node`: remove the target node.
- `move_node`: move the existing target node to the new parent/index.
- `set_property`: set runtime DOM properties that attributes do not reliably represent.

### Morphdom fallback

Use `morphdom` for `replace_subtree` operations and recovery reconciliation.

Suggested use cases:

1. A parent receives many child-list changes in one flush.
2. A framework replaces a large subtree where individual mutations are noisy.
3. Replay detects patch desynchronization and has a trusted serialized subtree.
4. A semantic refresh boundary provides a new full document or large root subtree that should be reconciled without iframe reload.

Suggested options:

```ts
morphdom(existingNode, targetNodeOrHtml, {
  childrenOnly: mode === "children",
  getNodeKey(node) {
    return getPreviewReplayNodeKey(node);
  },
  onBeforeElUpdated(fromEl, toEl) {
    preserveReplayOnlyState(fromEl, toEl);
    return true;
  },
});
```

Morphdom rules:

- It is an apply detail, not the recording format.
- It must operate inside the existing iframe document.
- It must not trigger iframe navigation.
- It should preserve input/focus state when semantic interaction replay owns that state.
- It should ignore replay-only markers and overlays.

## Storage and Compatibility

### New recordings

New recordings should store:

- Existing editor frame deltas.
- Existing semantic preview events.
- New initial preview document seed when preview recording begins.
- New preview patch batches for DOM evolution.

Full preview content in `preview_refresh` should become optional or fallback-oriented once patch replay is stable.

### Existing recordings

Existing recordings should continue to replay through the current full-content preview path.

Compatibility behavior:

- If no `previewPatchBatches` exist, use current `previewEvents` and `PreviewState.content` behavior.
- If patch batches exist, prefer patch replay for DOM state.
- If patch replay fails validation, fall back to the nearest available full preview content path without visible iframe reload.

### Format versioning

Use a small preview patch format version:

```ts
const PREVIEW_DOM_PATCH_FORMAT_VERSION = 1;
```

Avoid coupling every patch-format adjustment to the entire recording schema unless persistence requires it.

## Implementation Phases

### Phase 1: Types and Recording Storage

Scope:

- Add preview patch batch types.
- Add recording field for preview patch batches.
- Add recording-session append helper for patch batches.
- Keep existing preview snapshot behavior unchanged.

Expected files:

- `src/core/src/slides.ts` or a new preview patch type module.
- `src/core/src/types.ts`.
- `src/core/src/machine/recordingSession.ts`.
- Storage codec surfaces if the recording type requires explicit schema handling.

Exit criteria:

- The app can represent preview patch batches without changing current behavior.

### Phase 2: Injected Patch Recorder

Scope:

- Extend runtime injection to produce normalized patch batch messages.
- Keep current full snapshot message as fallback.
- Add batching and coalescing.
- Include document id and revision counters.

Expected files:

- `src/contexts/webContainerRuntimeSupport.ts`.
- `src/utils/iframeInteractionCapture.ts` only if shared iframe-side helpers are useful.

Exit criteria:

- The parent can receive patch batch messages from the live preview without changing replay behavior yet.

### Phase 3: Parent Message Handling

Scope:

- Handle the new patch batch message type.
- Append patch batches to the recording session.
- Preserve existing preview event semantics.
- Do not create `preview_refresh` events from ordinary DOM mutations.

Expected files:

- `src/components/preview/usePreviewMessageBridge.ts`.
- `src/core/src/machine/editorMachine.ts` if event routing needs a new machine event.
- `src/core/src/machine/recordingSession.ts`.

Exit criteria:

- Recording captures patch batches while existing preview playback still works through the old path.

### Phase 4: Patch Apply Utilities

Scope:

- Add DOM patch deserialization and apply helpers.
- Add node lookup by stable id/path.
- Add direct operation application.
- Add `morphdom` dependency and subtree reconciliation helper.

Expected files:

- `src/components/preview/previewIframeUtils.ts` or a new adjacent module.
- `package.json` for `morphdom` dependency.
- Type declarations only if the dependency does not provide adequate TypeScript types.

Exit criteria:

- A patch batch can be applied into an existing iframe document in place.

### Phase 5: Replay Integration

Scope:

- Track preview patch replay cursor state.
- Seed the replay document before showing it.
- Apply patch batches during playback.
- Apply patch batches when seeking.
- Keep semantic preview events on their current replay path.

Expected files:

- `src/components/preview/usePreviewPlaybackRegistration.ts`.
- `src/core/src/machine/replayState.ts`.
- `src/core/src/machine/editorMachine.ts`.

Exit criteria:

- Recordings with patch batches replay preview DOM changes in the persistent iframe without full reload.

### Phase 6: Prefer Patch Path for New Recordings

Scope:

- Stop treating full HTML snapshot as the normal preview state path for new recordings.
- Retain full snapshot fallback at explicit semantic boundaries.
- Keep existing recording compatibility.

Expected files:

- `src/components/preview/usePreviewMessageBridge.ts`.
- `src/components/preview/usePreviewController.ts`.
- Recording codec surfaces if needed.

Exit criteria:

- New recordings primarily use initial seed plus patch batches for preview DOM replay.

## Failure and Recovery Behavior

Patch replay should fail soft, not flash.

Recovery strategy:

1. Detect revision mismatch or missing target node.
2. Pause patch application for the affected document id.
3. Try `replace_subtree` with the smallest trusted ancestor if available.
4. If no subtree recovery is available, use the nearest explicit document seed or full preview content fallback.
5. Reconcile in place with `morphdom` rather than replacing the iframe document.
6. Mark the replay state as recovered so later patch batches can continue from a known revision.

Desync should be observable in development logs, but it should not break playback for the viewer.

## Edge Cases

### Script tags

Recorded script nodes should not re-execute during replay unless explicitly intended.

Replay should treat preview replay as visual state restoration, not a live app boot process. When deserializing script elements, prefer inert reconstruction or skip executable behavior.

### Stylesheets and style tags

Style tag text and stylesheet link attributes should be captured as DOM mutations.

External stylesheet loading during replay should use the same resource rewriting rules as current replayable preview HTML.

### Forms and inputs

DOM attributes are not enough for form state.

Capture or preserve these as properties when necessary:

- `value`
- `checked`
- `selected`

Keep interaction replay as the owner of visible user interaction timing.

### Focus and selection

Focus should remain in the semantic interaction stream unless a concrete DOM patch requires otherwise.

Text selection can remain out of scope for the first patch implementation unless current preview replay already depends on it.

### Canvas, video, and media

Canvas pixels and media playback state are not represented by DOM mutations alone.

For the first implementation, preserve current behavior and document these as unsupported or fallback-only surfaces.

### Shadow DOM

MutationObserver does not automatically observe closed shadow roots.

Open shadow roots can be considered later, but the first version should focus on the regular document DOM.

### Iframes inside preview

Nested iframes should not be patched deeply in the first version unless they are same-origin and already under Next Editor's control.

Treat iframe element attributes as normal DOM, but do not attempt nested document replay initially.

## Acceptance Criteria

The implementation is complete when:

1. New recordings store an initial preview document seed and subsequent DOM patch batches.
2. Ordinary preview DOM updates no longer require full HTML snapshot storage as the main path.
3. Replay applies patch batches inside one persistent iframe.
4. Route changes replay without iframe navigation.
5. Run/Cmd+S preview refresh boundaries remain semantic preview events.
6. Existing recordings without patch batches still replay through the compatibility path.
7. Patch desync recovers in place without visible iframe flashing.

## Risks

1. Node identity can drift if generated ids are not stable across remove/move/reinsert operations.
2. Framework-driven DOM churn may produce noisy mutation batches that need subtree coalescing.
3. Script/style/resource handling can accidentally change replay behavior if not kept inert and compatible with existing rewriting.
4. Seeking may be slower without interval checkpoints because replay must apply patches from the nearest semantic seed.
5. Morphdom can overwrite runtime state unless hooks preserve replay-owned state carefully.
6. Patch records may be larger than full snapshots for very large wholesale DOM replacements unless coalesced into `replace_subtree`.

## Open Decisions

1. Whether node ids should be stored only in iframe-side weak maps or also as private DOM attributes.
2. Whether initial document seeds should live in a new `previewDocuments` collection or as a special patch batch type.
3. How much full-preview content should remain in `preview_refresh` after the patch path becomes stable.
4. Whether static preview and runtime preview should share one patch recorder or use separate adapters with a shared patch schema.
5. How aggressively to coalesce child-list mutations into `replace_subtree` in the first implementation.

## Recommended First Implementation Slice

Start with the smallest reversible vertical slice:

1. Add preview patch types and recording storage.
2. Emit patch batches from the injected preview recorder while keeping full snapshots active.
3. Record those patch batches without using them for replay yet.
4. Add patch apply utilities and integrate replay behind a feature flag or internal capability check.
5. Switch new recordings to prefer patch replay only after the compatibility path is proven stable.

This keeps the current working no-flash replay path intact while the patch system is introduced gradually.
