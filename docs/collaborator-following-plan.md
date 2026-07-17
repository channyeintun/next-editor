# Live Teaching Collaboration and Collaborator Following — Implementation Plan

Status: proposed

Priority: P0

Parent design: [Live Collaboration Feature Plan](./live-collaboration.md)

Product inspiration:
[Zed Channels — Following Collaborators](https://zed.dev/docs/collaboration/channels#following-collaborators)

## Summary

Replace the current `Follow host's active file` toggle with person-centered, cross-surface
following, and make slides and whiteboard real collaborative room content. A user selects any
online participant once; the local app then follows that exact session's visible surface:

1. the code editor — active text file, cursor, selection, and vertical/horizontal viewport;
2. presentation slides — whether that participant has the shared room presentation open;
3. the whiteboard — whether it is open plus that participant's pan/zoom viewport.

Any intentional local interaction stops following before the action is processed. The follower
keeps the last applied surface and position rather than jumping back.

Following is only the view layer. Slide and whiteboard work must be divided into three deliberately
separate state classes:

- shared content is durable and room-wide: slide add/edit/delete/reorder, shared presentation
  position/build step, and whiteboard element upserts/removals converge for every participant just
  like Monaco text and workspace tree changes;
- shared live interactions are room-wide: bounded slide iframe interactions are delivered to every
  live participant and are not gated by follow state;
- active surface, open/closed state, and per-participant viewport are ephemeral awareness and are
  applied only by followers;
- the selected follow target is browser-tab-local UI state and is never sent to the server.

Slides and whiteboard content are currently browser-local stores. Therefore, mirroring only
open/closed state or whiteboard coordinates would be incomplete: another participant could land on
a different deck or an empty canvas and would miss drawings or slide interactions. The shared
teaching-surface collaboration foundation in this plan is a P0 prerequisite for exposing
cross-surface following.

The Zed reference is behavioral inspiration only. The implementation should use Next Editor's
existing Yjs, awareness, recording, slide, and Excalidraw primitives rather than copying Zed
source.

## Recommendation

Ship room-wide slide/whiteboard collaboration together with one follow concept across all
first-class teaching surfaces. Do not make collaborative content conditional on following a
participant.

Internally, deliver the work in two gates:

1. make deck changes, presentation changes/interactions, and whiteboard element deltas authoritative
   and visible to the whole room;
2. enable the participant follow UI after editor, slide, and whiteboard surface adapters pass the
   same lifecycle and local-intent tests.

The surface adapters may land incrementally behind the protocol revision, but the visible
`Follow` action should not promise cross-surface following until all three are ready.

## Why this is the next improvement

The current collaboration implementation already provides the core distributed-system
foundation:

- stable participant identity through application user ID plus per-tab session ID;
- active-file presence;
- Yjs-relative cursors and standard `y-monaco` relative selections;
- remote cursor and selection decorations;
- coalesced binary awareness over the room Durable Object;
- awareness TTL, reconnect, roles, room lifecycle, and content-addressed room assets.

The current behavior follows only the host's `activeFileNodeId`. It cannot select another
participant, mirror a viewport, track a surface transition, or stop in response to local
interaction. The participant list is informational instead of actionable.

Next Editor also differs from a code-only IDE: presentations and the whiteboard are first-class
teaching surfaces. Following a presenter should continue when that presenter leaves Monaco to
explain a slide or draw a diagram.

## Goals

- Let any room participant follow any other online participant in the same room.
- Follow one exact participant session across editor, slides, and whiteboard.
- Follow the target's text file and CRDT-anchored vertical/horizontal Monaco viewport.
- Keep the target's existing remote editor cursor and selection visible.
- Collaborate on one room deck: every owner/editor receives and can publish authorized
  add/edit/delete/reorder operations.
- Apply shared slide changes/build steps and bounded iframe interactions to every live participant,
  whether or not they follow the author.
- Use follow state only to mirror whether the target has slides open; the current shared slide is
  room state rather than participant awareness.
- Apply whiteboard element upserts/removals to every participant using the same delta semantics as
  the recording codec.
- Follow the target's Excalidraw `scrollX`, `scrollY`, and zoom without replacing the follower's
  shared canvas with awareness data.
- Use follow state only for whiteboard open/close and viewport; drawing changes never require a
  follow target.
- Make follow state obvious, surface-aware, and keyboard-accessible above modal surfaces.
- Stop immediately on intentional local editor, slide, whiteboard, or surface-navigation input.
- Allow owners, editors, and viewers to follow; write permissions remain unchanged.
- Suspend application during transient reconnect and resume when the same target session returns.
- Keep awareness bounded, ephemeral, coalesced, and compatible with Durable Object hibernation.
- Preserve standalone stores, playback isolation, host-only recording, and existing cursor
  rendering.

## Non-goals

- Split-pane or pane-specific following. Next Editor currently has one primary editor surface.
- Following preview routes, runtime state, terminals, logs, audio/video calls, or screen shares.
- Sharing arbitrary authored JavaScript execution inside slides. Only the trusted, bounded
  interaction bridge may replay supported interactions.
- Guaranteeing delivery of already-completed transient slide gestures to a participant who was
  offline; reconnect restores durable deck/presentation/checkpoint state.
- Showing a remote whiteboard pointer, selected Excalidraw tool, selected elements, or collaborator
  cursors in the first release.
- Remote-controlling the followed participant or granting the follower write permission.
- Persisting the follower's target in Yjs, D1, SQLite, a URL, a recording, or local storage.
- Following an offline member or silently switching to a replacement tab for the same account.
- Follower-graph visualization, cycle detection, or guaranteed transitive following behavior.
- Replacing the follower's Monaco selection with the target selection. Existing colored remote
  decorations continue to represent the target.
- Changing host assignment, recording ownership, invitation behavior, SCR3 encoding, or runtime
  execution boundaries.

## Collaboration versus following

| Surface    | Room-wide collaboration for every participant                                                                    | Follow-only view state                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Editor     | Existing Yjs project nodes/texts and workspace commands                                                          | active file, relative viewport anchor, horizontal scroll, cursor, selection |
| Slides     | deck CRUD/order, payload assets, shared current slide/build step, bounded `slide_interaction` events/checkpoints | presentation open/close/maximize/minimize                                   |
| Whiteboard | `upserts` and `removedIds` using `WhiteboardEvent` delta semantics                                               | open/close/maximize/minimize and `scrollX`/`scrollY`/zoom                   |

Receiving a room-wide change never opens or closes a participant's slide/whiteboard UI. It updates
the underlying shared state so the content is already current if the surface is visible now or
opened later. Only following a participant can mirror that participant's surface visibility or
viewport.

The awareness layer never transports slide markup, slide interactions, Google SVG, build-step
data, or whiteboard elements. Those use the durable/shared teaching planes described below.

## User experience contract

### Starting and switching follow

1. Every remote participant row in `Online now` exposes a `Follow` action.
2. The current tab/session is not a followable target.
3. Activating `Follow` selects that participant's exact `sessionId`.
4. Activating another participant switches targets immediately.
5. Activating the current target again, the visible `Stop` action, or `Escape` stops following.
6. The host remains visibly identified but is no longer the only follow target.

The row shows the participant's active surface:

- `index.ts · line 42` or the resolvable active filename for the editor;
- `Slides · 3/12` when the shared deck is available;
- `Whiteboard`;
- `Loading shared slide…` when a durable content reference arrived before its asset.

The follow action must have an accessible name such as `Follow Ada` and an accessible pressed
state. Color alone must not communicate follow state.

### Active follow indicator

While following:

- render an EditorLayout-level overlay such as `Following Ada · Slides · Esc to stop`;
- outline the currently visible editor, slide, or whiteboard surface with the target's existing
  participant color;
- show `Following` on the target's participant row;
- keep the overlay above the slide and whiteboard modal layers without intercepting their input;
- do not steal focus from the active surface or collaboration panel;
- apply remote view changes immediately rather than queuing animations.

The overlay belongs above all three surfaces, not inside `CodeEditor`, because Monaco may be
covered while the target is presenting.

### Surface switching

Only one local visible surface is active at a time:

- opening slides closes the whiteboard;
- opening the whiteboard closes slides;
- closing either returns to the editor;
- a transient legacy state with both open resolves deterministically to whiteboard, then closes
  the obscured slide surface.

Target-driven open/close switches run under a programmatic-application guard. Local header buttons,
backdrop clicks, and close controls stop following before changing surfaces. None of these local
visibility changes alter the room deck, shared slide position, slide interaction state, or
whiteboard elements.

### Editor application

For each accepted target editor state:

1. Resolve the target file node through the current collaboration projection.
2. Navigate to a different text file as follow navigation, not local navigation.
3. Wait until Monaco has attached the matching model.
4. Resolve the target's CRDT-relative top-of-viewport anchor against the matching Y.Text.
5. Apply the resolved vertical position, bounded intra-line pixel delta, and horizontal scroll.
6. Leave cursor and selection rendering to the existing awareness decoration path.
7. If the viewport is missing but the target cursor resolves, reveal that cursor without changing
   the follower's selection.

If the target opens a binary file, follow the file selection but do not apply a text viewport.

### Slide collaboration and follow application

Deck and presentation changes are room-wide, independent of following:

1. Slide add/edit/delete/reorder/import commands update the shared deck document.
2. `slide_change` updates the room's current `slideId` and build-step index.
3. `slide_interaction` is validated, sequenced, and delivered to every live participant; stateful
   input/scroll effects also update a compact shared checkpoint for reconnect.
4. Every client projects these changes even when its slide overlay is closed.

Following controls only local visibility. When the selected target publishes the `slides` surface:

1. Resolve the room's current slide, never a standalone local-storage slide.
2. Wait for its payload asset to hydrate if durable state arrived before the asset.
3. Close the whiteboard and open the presentation overlay under the application guard.
4. Render the latest room slide/build step and apply subsequent room-wide interactions.

When that target leaves the slide surface, close it for the follower without changing shared
presentation state. If content is missing, retain following and show a nonfatal loading/unavailable
state; never display a different local slide as a fallback.

`slide_change` and `slide_interaction` must not be placed in participant awareness or filtered by
`followedSessionId`.

### Whiteboard application

Whiteboard element changes are room-wide. Every valid local `upserts`/`removedIds` delta becomes a
collaborative document transaction and every participant projects it, whether the whiteboard is
open, closed, followed, or independently viewed.

For each accepted target whiteboard view state:

1. Ensure the room whiteboard element projection is attached.
2. Close slides and open the whiteboard under the application guard.
3. Apply only `scrollX`, `scrollY`, and zoom through `ExcalidrawImperativeAPI.updateScene`.
4. Use `CaptureUpdateAction.NEVER` and preserve the projected shared elements.
5. Do not copy the target's tool, selection, pointer, or app-local preferences.

When the target closes the whiteboard, close it for the follower without clearing elements.
Following controls only local open/close and which participant's viewport is applied.

### Stopping follow

Stop before processing any intentional local action:

- Monaco key, pointer, wheel/trackpad, scrollbar, paste, or IME input;
- selecting a file in the sidebar;
- slide previous/next controls, arrow-key navigation, backdrop/close, iframe interaction, or slide
  manager actions;
- whiteboard pointer, wheel, pan, zoom, keyboard shortcut, tool choice, drawing, or close action;
- opening another surface from the header;
- leaving/closing the room, entering playback, or selecting another target.

The first `Escape` while following is consumed by follow mode and leaves the current surface open.
A second `Escape` may perform the surface's normal close behavior.

After stopping, the current surface and viewport stay where they were. Remote content updates,
layout changes, model/asset attachment, recording capture, and guarded follow application are not
local intent.

For an owner/editor, the action that stopped following still proceeds through the room-wide write
path: slide navigation/interaction changes the shared presentation, and whiteboard drawing emits a
shared delta. A viewer stops following but remains read-only.

### Target loss, reconnect, and playback

- During local reconnect, retain `followedSessionId` but suspend all surface application.
- Resume only when the connection is live and the same session is present.
- Stop on an explicit target leave, awareness TTL expiry, or room replacement.
- A target page reload creates a new session ID and requires a new follow action.
- Entering playback stops following and pauses live teaching-surface projection.
- Unloading playback reprojects the current room deck and whiteboard before live input is enabled.

### Recording behavior

Recording authority remains host-only and browser-local.

- Shared deck operations, `slide_change`, `slide_interaction`, and whiteboard element deltas project
  into the host's existing stores and recording actions whether or not the host follows their
  author.
- If the recording host deliberately follows another participant, the host's visibly applied
  slide/whiteboard open/close and whiteboard view changes are recorded exactly once.
- Follow-applied visibility/view changes must not be republished as the host's local awareness.
- Room-wide content/interaction events are forwarded to the recorder exactly once from their
  canonical collaboration application path; projection in multiple browsers must not duplicate
  them in the host's SCR3.
- A non-host follower never gains recording controls.

Reuse the semantic `SlideEvent` and `WhiteboardEvent` shapes when feeding the recorder, but do not
use SCR3 segments as the network transport. Split fields by ownership before transport:

- `slide_open`/`slide_close`/maximize/minimize and whiteboard open/view are local/follow view events;
- `slide_change`/`slide_interaction` and whiteboard `upserts`/`removedIds` are canonical room-wide
  collaboration events.

The current slide replay fold may infer an open presentation from a non-close slide event. Refactor
it so only the host's recorded open/close view events control visibility; shared
`slide_change`/`slide_interaction` update retained presentation state without forcing the overlay
open during replay.

Use separate guards for room-write echo suppression, awareness echo suppression, live interaction
replay, and recording capture.

## State model and invariants

`CollaborationContext` owns the local follow choice:

```ts
type CollaborationFollowStopReason =
  | "user"
  | "local-editor-input"
  | "local-scroll"
  | "local-file-navigation"
  | "local-slide-input"
  | "local-whiteboard-input"
  | "local-surface-change"
  | "target-left"
  | "room-changed"
  | "playback";

interface CollaborationFollowState {
  followedSessionId: string | null;
}
```

The public context should expose:

```ts
followedSessionId: string | null;
followedParticipant: CollaborationParticipant | null;
followParticipant(sessionId: string): void;
stopFollowing(reason?: CollaborationFollowStopReason): void;
publishSurface(surface: LocalCollaborationSurface): void;
publishSlideInteraction(event: CollaborationSlideInteraction): void;
isApplyingFollow: boolean;
```

Required invariants:

- at most one target per browser tab;
- the target is never the provider's own `awarenessSessionId`;
- follow does not grant write access or bypass viewer guards;
- the target choice is not encoded in shared content, awareness, URL, invitation, recording, or
  recovery export;
- follow-view application runs only for a live provider, a current target, and a non-playback
  editor;
- only awareness from the selected `sessionId` can move the local view;
- shared deck/presentation operations, slide interactions, and whiteboard element deltas apply
  regardless of `followedSessionId`;
- viewers receive every canonical shared change but cannot publish durable content or live
  interactions;
- every target awareness revision is applied at most once;
- stale revisions, stale sessions, and late asset hydration cannot overwrite a newer surface;
- room projection and remote interaction replay do not publish write or interaction echoes;
- programmatic follow application does not cancel itself or publish an awareness echo;
- stopping is idempotent.

Use `sessionId`, not `actorId`, because the same account can have multiple tabs with independent
surfaces and viewports.

## Shared teaching-surface content

### Current gap

`slidesStore` persists one browser-local deck under `next-editor-slides`, and `whiteboardStore`
holds a browser-local Excalidraw scene. Neither is currently seeded into or projected from the room
Y.Doc. `SlideEvent` and `WhiteboardEvent` currently feed only the recording machine; they are not a
live collaboration protocol. The feature must turn their applicable changes into room operations,
not merely assume each follower has matching local stores.

### Recording-event ownership map

Reuse existing event semantics after splitting them by ownership:

| Existing event field/type                      | Live collaboration ownership | Delivery/application                                                               |
| ---------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| slide add/edit/delete/reorder/import           | durable room content         | Yjs manifest/order transactions plus private payload assets; projected by everyone |
| `slide_change` (`slideId`, `indexv`)           | durable room presentation    | convergent shared current position; projected by everyone                          |
| `slide_interaction`                            | room-wide live interaction   | ordered bounded event to all live clients plus compact stateful checkpoint         |
| `slide_open`, `slide_close`, maximize/minimize | participant view             | awareness; applied only by followers of that exact session                         |
| whiteboard `upserts`, `removedIds`             | durable room content         | Yjs element transactions; projected by everyone                                    |
| whiteboard `view`, `isOpen`, `isMaximized`     | participant view             | awareness; applied only by followers of that exact session                         |

Do not serialize a mixed `WhiteboardEvent` wholesale onto one transport. Split its element delta
from its view fields first, then recompose the semantic event only when feeding the host recorder.

### Additive document model

Add an optional `teaching` child under the existing `project` root:

```text
project
  schemaVersion
  metadata
  nodes
  texts
  teaching
    initialized
    slideOrder: ordered stable slide IDs
    slides: slide ID -> validated manifest record + content asset descriptor
    presentation: current slide ID + build-step index + revision
    slideInteractionCheckpoints: slide/target -> bounded input or scroll state
    whiteboardElements: element ID -> validated Excalidraw JSON snapshot/tombstone
```

Do not store slide/whiteboard open/closed/maximized state, whiteboard viewport, or follow targets
here. Those are participant awareness or local UI state. The shared current slide/build step is
room content and is intentionally stored.

Treat this as a backward-compatible optional extension to document schema version 1:

- old project projection ignores the additional child map;
- a missing `teaching` map means “not initialized,” not “import whichever local store joined
  first”;
- new rooms seed it once from the creator's current deck and whiteboard;
- an existing room requires an explicit owner action to initialize it from the owner's current
  surfaces, preventing a join race;
- once initialized, the room document is authoritative until the participant leaves.

Because the stored project schema remains readable and existing room documents need no rewrite,
keep `COLLABORATION_DOCUMENT_SCHEMA_VERSION` at 1. If implementation discovers that the existing
projection or compaction path cannot preserve unknown optional children, stop and promote this to
a version-2 document migration instead of silently dropping teaching data.

### Slide manifest and payload assets

Slide records retain a stable, bounded opaque ID so existing Google page IDs and recordings remain
resolvable. New custom slides should use `crypto.randomUUID()` instead of `Date.now()`. Normalize
duplicate IDs before the initial room seed.

Keep only bounded metadata and a content-addressed payload descriptor in Yjs. Store each slide's
`content` and optional Google build-step data as a validated room asset. This prevents multi-megabyte
SVG strings from exceeding the 64 KiB Yjs update limit or 4 MiB snapshot limit.

Requirements:

- upload the payload before publishing or updating its manifest reference;
- hydrate assets through the existing private room asset path;
- preflight per-asset, room-byte, and room-count quotas with an actionable error;
- reuse hashes for unchanged slides and include slide payload references in room cleanup;
- never render a missing asset as a different local slide;
- reject unsafe or malformed manifest/payload fields before store projection;
- require a live connection for asset-backed slide saves; do not publish dangling offline
  references.

Concurrent order changes need deterministic projection: deduplicate repeated IDs by first
occurrence, omit tombstoned slides, and append live records missing from the order list by stable
ID. Add/delete/reorder commands remain Yjs transactions.

### Shared slide position and interactions

`slide_change` is analogous to a shared workspace command, not active-file awareness. An
owner/editor navigation transaction updates the room presentation's current slide ID and
build-step index. Every client applies the converged value if the slide UI is mounted and keeps it
ready if the UI is closed. A concurrent navigation resolves through the Yjs transaction order and
all clients converge on one room position.

`slide_interaction` is also room-wide, but not every interaction is durable state. Add a bounded
binary teaching-event frame with canonical actor/session identity, event ID, per-session sequence,
slide ID, and validated `IframeInteractionEvent`. The Durable Object:

```ts
interface CollaborationSlideInteraction {
  eventId: string;
  sequence: number;
  slideId: string;
  payloadRevision: string;
  interaction: Omit<IframeInteractionEvent, "timestamp">;
}
```

- accepts it only from owner/editor connections;
- rate/size limits it separately from coalesced awareness;
- validates the per-sender sequence, deduplicates event IDs, assigns one canonical room interaction
  revision, and fans that same total order to all live clients;
- never filters delivery by follow target;
- does not persist pure click/focus/blur/hover/key gestures after fan-out.

For stateful input and scroll interactions, also update a compact Yjs checkpoint keyed by stable
slide/target identity. A reconnecting client restores checkpoints after the slide iframe mounts;
it does not replay an unbounded gesture history.

A live client whose matching slide iframe is not mounted keeps a small bounded queue by slide ID
and presentation revision. It applies the queue in order when that exact document mounts, drops it
when the room position or payload revision makes it stale, and then applies the durable checkpoint.

The current slide renderer captures `slide_interaction` but does not apply it. Add one trusted
nonce-restricted iframe bridge shared by recording playback and live collaboration. The bridge:

- runs only after authored scripts have been stripped by `sanitizeSlideContent`;
- accepts commands only from its parent window;
- is accepted by the parent only when `event.source` matches the active slide iframe's
  `contentWindow`;
- resolves a bounded ID/XPath target and verifies the expected tag;
- applies supported click/focus/blur/input/scroll/key effects;
- suppresses capture while applying a remote command to prevent event echoes;
- reports an unresolved/stale target nonfatally.

Raw HTML and Markdown slides currently use script-disabled iframes. Enabling the trusted bridge
requires `sandbox="allow-scripts"` plus a nonce-restricted CSP while continuing to block authored
scripts, forms, navigation, and network access. Treat this as a security-sensitive change with
dedicated sanitizer/CSP tests.

### Whiteboard element projection

Images remain disabled, matching the current whiteboard scope. Store validated element snapshots
by Excalidraw element ID and keep soft-deleted tombstones long enough to prevent resurrection.
Preserve Excalidraw fractional `index` ordering.

The adapter must:

- reconcile concurrent element versions deterministically using Excalidraw version/versionNonce
  semantics before projecting;
- reuse `snapshotWhiteboardDelta` so mutable Excalidraw elements become cloned
  `upserts`/`removedIds` snapshots in the existing 100 ms window;
- translate those deltas into Yjs element-map transactions instead of sending full scenes;
- translate remote Yjs key changes back into the same delta shape and fold them with the extracted
  `applyWhiteboardEvent` logic;
- apply remote element deltas through `updateScene` without replacing the local viewport or
  opening the whiteboard;
- suppress CRDT/store feedback when projecting remote transactions;
- bound element count, serialized element size, and total scene size below room update/snapshot
  limits;
- reject an oversized stroke with a recoverable UI error rather than disconnecting the room;
- exclude awareness-only open/close/maximize/pan/zoom fields from durable element updates.

Every connected participant receives element deltas even with no follow target. If its whiteboard
is closed, the store still advances so opening later renders the converged scene immediately.

### Store scoping

Entering a room must not overwrite the user's standalone slide deck in global local storage.

- Snapshot the standalone slide/whiteboard stores before room projection.
- While connected, project room content into a room scope and disable the existing unscoped slide
  persistence subscriber for those changes.
- A room-specific cache, if added, must be keyed by room ID and schema and remain non-authoritative.
- On leave, restore the standalone snapshots; on room switch, fully detach the old observers first.
- Playback store writes never publish to the live room.

## View awareness and live interaction protocol

### Discriminated surface state

Replace `activeFileNodeId` plus the editor-only viewport with one bounded discriminated union:

```ts
interface CollaborationEditorViewport {
  topAnchor: string; // base64 Yjs relative position in fileNodeId
  topDeltaPx: number;
  scrollLeftPx: number;
}

type CollaborationSurface =
  | {
      kind: "editor";
      fileNodeId: string | null;
      viewport: CollaborationEditorViewport | null;
    }
  | {
      kind: "slides";
      isMaximized: boolean;
    }
  | {
      kind: "whiteboard";
      isMaximized: boolean;
      viewport: {
        scrollX: number;
        scrollY: number;
        zoom: number;
      };
    };
```

The version-3 awareness state becomes:

```ts
{
  sessionId,
  revision,
  surface: CollaborationSurface,
  cursor: CollaborationCursor | null,
}
```

Keep the standard optional `selection` alongside `collaboration` for `y-monaco`. Clear custom
cursor and standard selection when publishing a slide or whiteboard surface so stale Monaco
decorations do not imply the target is still editing.

Remove `followingHost`. Follow target identity is local-only, and no server behavior should consume
it.

### Validation

View awareness:

- editor `fileNodeId`: existing collaboration UUID schema;
- editor `topAnchor`: existing encoded-relative-position limit, currently 2 KiB;
- editor `topDeltaPx`: finite and clamped to `0..4096`;
- editor `scrollLeftPx`: finite and clamped to `0..1_000_000`;
- slide/whiteboard `isMaximized`: strict boolean;
- whiteboard `scrollX` and `scrollY`: finite and bounded to safe Excalidraw world coordinates;
- whiteboard zoom: finite and bounded to the Excalidraw-supported zoom range;
- reject unknown fields and mixed-surface shapes;
- keep the complete binary awareness frame below the existing 16 KiB server limit.

Room-wide teaching interaction:

- event ID: UUID; client sequence: nonnegative safe integer increasing per session;
- canonical room interaction revision: server-generated and strictly increasing within its room
  epoch;
- slide ID and payload revision: bounded and required so stale-document events can be dropped;
- interaction type: existing supported `IframeInteractionType` enum only;
- target tag/ID/class/XPath and key/code/value strings: individually and collectively bounded;
- coordinates and scroll values: finite, clamped, and normalized against the recorded source frame
  size where present;
- complete interaction frame: a dedicated small maximum no larger than the existing 16 KiB
  awareness ceiling;
- client timestamp is never authoritative; the receiving host recorder assigns its own recording
  timestamp after canonical application.

Every field is untrusted. The server validates strict shapes and canonicalizes actor/session/role;
the client revalidates document revision, target resolution, and local library bounds before
applying.

### Capturing and publishing view awareness

Use one active-surface bridge beneath `SlidesProvider` and `WhiteboardProvider`:

- editor is active when neither modal teaching surface is visible;
- slides are active when the presentation overlay is visible;
- whiteboard is active when its overlay is visible;
- whiteboard wins a transient both-open state before exclusivity repair.

Reuse the current 75 ms awareness coalescer for all surfaces. Do not add a separate scroll or
whiteboard socket stream.

Publish after:

- Monaco scroll, model attachment, active-file change, and view-state restoration;
- slide open, close, maximize, and minimize;
- whiteboard open, close, pan, and zoom.

Do not publish slide navigation/build changes, slide iframe interactions, whiteboard element
deltas, content-size-only Monaco scroll events, or follow-applied view changes as awareness.
Continue the 15-second heartbeat with the latest complete surface state and remain below 20
awareness updates per second.

### Monaco viewport anchors

Add pure helpers, preferably in `src/collaboration/editorViewport.ts`:

1. Read Monaco's first visible range.
2. Convert its top-line start to an offset in the matching Y.Text.
3. encode a Yjs relative position;
4. compute the intra-line pixel delta and horizontal scroll;
5. return `null` for a missing/binary/mismatched model.

Resolve the anchor only against the Y.Text for the target file node. A relative anchor keeps the
same logical content visible through concurrent insertions above the viewport. Fall back to the
target cursor when it cannot resolve.

### Versioning decision

The strict awareness state and binary frame set change, so increment
`COLLABORATION_BINARY_PROTOCOL_VERSION` from 2 to 3. Binary v3 carries the existing sync/update and
awareness frames plus the bounded room-wide teaching-interaction frame. Keep
`COLLABORATION_PROTOCOL_VERSION` at 2 and, subject to the additive-root preservation test above,
keep `COLLABORATION_DOCUMENT_SCHEMA_VERSION` at 1.

Deploy browser and Worker from the same revision. A stale binary-v2 client must receive the
existing protocol-mismatch/reload path rather than having awareness reinterpreted.

No D1 or Durable Object SQLite migration is expected because pure live interaction gestures are
not persisted; reconnect state uses the Yjs teaching checkpoints. Slide payloads use existing
private room R2 assets, and their references must participate in existing room cleanup.

## Component architecture

`CollaborationProvider` currently sits above `SlidesProvider` and `WhiteboardProvider`, so it cannot
directly call their controllers. Avoid a broad provider reorder. Add a
`CollaborationSurfaceBridge` below all three providers and mount it next to `EditorLayout`.

The bridge:

- observes slide and whiteboard controllers plus the active Monaco adapter;
- publishes the one current surface through `CollaborationContext`;
- applies open/close and viewport awareness only from the selected participant;
- projects shared deck/presentation and whiteboard element changes for every participant;
- sends and applies room-wide slide interactions without consulting follow state;
- coordinates mutually exclusive overlays;
- owns distinct document, live-interaction, and awareness-application guards;
- observes/projects the optional teaching Yjs subtree;
- retries a pending visible surface after its durable slide asset or whiteboard projection arrives.

`CollaborationContext` remains responsible for participant lifecycle, the selected session,
provider state, coalesced awareness, validated room-wide teaching-event fan-out, and room-level
seeding. It can read the ancestor low-level slide/whiteboard stores during `createRoom`;
controller-level UI application stays in the bridge.

## Data flow

```mermaid
flowchart LR
    LocalWrite[Owner/editor local change] --> Durable[Room Yjs + private slide assets]
    Durable --> Projection[All-client teaching projection]
    Projection --> Slides[Shared deck + presentation state]
    Projection --> Whiteboard[Shared whiteboard elements]

    SlideGesture[Local slide iframe interaction] --> Event[Validated teaching-event frame]
    Event --> AllLive[All live room clients]
    AllLive --> Slides

    Target[Followed participant] -->|surface visibility + viewport awareness| Room[Room Durable Object]
    Room --> Follow[Selected-session filter]
    Follow --> Bridge[CollaborationSurfaceBridge]
    Bridge --> Monaco
    Bridge --> SlideVisibility[Slide open/close only]
    Bridge --> WhiteboardView[Whiteboard open/close + viewport only]

    LocalInput[Local key / pointer / wheel / surface action] --> Stop[stopFollowing]
    Stop --> Bridge
```

Durable teaching changes and live slide interactions fan out without a follow filter. Awareness may
arrive before the related durable update or R2 download; the bridge holds only the latest target
revision and retries visibility after content hydration. It never applies an older pending surface
after a newer awareness state.

## Implementation phases

### Phase 1 — shared teaching-surface foundation

| Task | Files                                                                                          | Work                                                                                                                                 | Acceptance                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `src/collaboration/teachingDocument.ts` (new), `src/collaboration/projectDocument.ts`          | Add optional teaching roots, bounded schemas, shared presentation position, seed/projection helpers, ordering, and origins.          | Two Y.Docs converge on deck/order/current slide/build step/whiteboard elements; old project projection preserves the root. |
| 1.2  | `src/contexts/CollaborationContext.tsx`, collaboration asset client/Worker paths               | Prepare slide payload descriptors, seed new rooms, upload before manifest publication, hydrate on join, and clean up with the room.  | A multi-megabyte Google SVG stays outside Yjs and appears in a second browser; missing/quota failures are recoverable.     |
| 1.3  | slide commands/controller and teaching adapter                                                 | Route deck CRUD/import and `slide_change` through authorized Yjs commands; project them for all clients without opening the overlay. | Two editors converge on deck and position without following; viewers receive changes but cannot publish.                   |
| 1.4  | `src/stores/slidesStore.ts`, `src/contexts/SlidesStoreContext.tsx`, teaching adapter           | Add standalone/room scoping and prevent room projection from overwriting `next-editor-slides`.                                       | Joining/leaving a room restores the exact standalone deck and detaches all old room observers.                             |
| 1.5  | `src/hooks/useWhiteboardController.ts`, `src/components/WhiteboardPanel.tsx`, teaching adapter | Reuse recording deltas for bounded Yjs element transactions; project them for everyone while preserving local view/open state.       | Two editors see the same strokes without following and may pan independently; viewer writes remain blocked.                |
| 1.6  | existing-room initialization UI                                                                | Offer an owner-only explicit initialization when the optional teaching root is absent; never auto-adopt a joiner's local store.      | Concurrent joins cannot seed competing local decks into an existing room.                                                  |

### Phase 2 — room interactions, view awareness, and follow lifecycle

| Task | Files                                                                              | Work                                                                                                                   | Acceptance                                                                                                   |
| ---- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 2.1  | `src/collaboration/protocol.ts`                                                    | Add strict view-awareness and teaching-interaction schemas; remove `followingHost` and top-level `activeFileNodeId`.   | View and interaction payloads round-trip separately; mixed, oversized, nonfinite, and unknown fields fail.   |
| 2.2  | `src/collaboration/binaryProtocol.ts`, Worker collaboration route/room object      | Add binary-v3 teaching-event frame, canonical identity, role/rate/size validation, ordering, dedupe, and fan-out.      | Version 2 fails explicitly; one editor interaction reaches every live client once without follow filtering.  |
| 2.3  | `src/collaboration/roomProvider.ts`                                                | Publish view awareness and discrete teaching events through separate APIs; preserve/clear Monaco selection correctly.  | Provider tests carry every view surface and room-wide interaction without cross-plane echoes.                |
| 2.4  | `src/contexts/CollaborationContext.tsx`                                            | Replace `isFollowingHost` with `followedSessionId`; add follow/stop/publish APIs and lifecycle cleanup.                | Any remote session can be followed; self/unrelated/stale sessions cannot move the UI.                        |
| 2.5  | `src/components/CollaborationSurfaceBridge.tsx` (new), `src/components/Editor.tsx` | Project room state/events for all; apply only visibility/viewport from the target; add separate echo/recording guards. | Shared changes work with no target; target view transitions apply once even when awareness precedes content. |

### Phase 3 — editor adapter

| Task | Files                                                                   | Work                                                                                            | Acceptance                                                                                                  |
| ---- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 3.1  | `src/collaboration/editorViewport.ts` (new), relative-position helpers  | Create/resolve bounded CRDT-relative Monaco viewport anchors.                                   | The logical top line survives concurrent insertion above it and fails safely for a deleted/mismatched text. |
| 3.2  | `src/components/CodeEditor.tsx`                                         | Capture meaningful local scroll and apply target file/viewport after matching model attachment. | Vertical/horizontal following works without awareness echo or animation backlog.                            |
| 3.3  | `src/components/CodeEditor.tsx`, `src/collaboration/monacoAwareness.ts` | Keep target decorations visible and use cursor reveal when viewport is absent.                  | Standard `y-monaco` and fallback cursor modes remain useful.                                                |
| 3.4  | `src/components/CodeEditor.tsx`, `src/components/FileSidebar.tsx`       | Stop before Monaco input or explicit file navigation while ignoring guarded/layout events.      | Key, pointer, wheel, scrollbar, paste, IME, and file click all hand control back locally.                   |

### Phase 4 — slides and whiteboard adapters

| Task | Files                                                                        | Work                                                                                                             | Acceptance                                                                                            |
| ---- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 4.1  | slide controller/panel/preview and teaching adapter                          | Apply shared slide position to all mounted previews; keep it ready while closed; apply room-wide interactions.   | Two non-following editors see navigation and supported iframe interactions; no interaction echo.      |
| 4.2  | `src/utils/sandboxedSlideDocument.ts`, slide renderers, interaction tests    | Add the nonce-restricted capture/apply bridge and checkpoint restore path shared by live mode and playback.      | Supported events apply safely in unique-origin frames; authored scripts remain blocked.               |
| 4.3  | `src/components/SlidesButton.tsx`, `src/components/EditorHeader.tsx`         | Follow only slide open/close/maximize state; stop before local controls, then publish authorized shared changes. | Local close does not change room position; owner/editor navigation remains room-wide after stop.      |
| 4.4  | `src/components/WhiteboardPanel.tsx`, `src/hooks/useWhiteboardController.ts` | Apply room element deltas for all; follow only open/close and pan/zoom with `CaptureUpdateAction.NEVER`.         | Drawing appears room-wide without moving independent clients; followers additionally mirror view.     |
| 4.5  | whiteboard wrapper/header controls                                           | Stop before local intent, then allow authorized drawing delta or local pan/zoom to proceed on the right plane.   | Drawing after stop remains shared; local open/close/pan/zoom is never written as room content.        |
| 4.6  | Next Editor recording actions, replay fold/bridge, and focused tests         | Feed canonical shared events and host-visible follow view events to existing recording shapes exactly once.      | SCR3 replays collaborative slide/whiteboard changes and host view without duplication or forced open. |

### Phase 5 — participant UI, hardening, and rollout

| Task | Files                                                                                             | Work                                                                                                                   | Acceptance                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 5.1  | `src/components/CollaborationPanel.tsx`                                                           | Replace the host checkbox with follow/stop actions and surface-aware participant labels.                               | Owner, editor, and viewer can follow any other online participant by keyboard or pointer.        |
| 5.2  | `src/components/CollaborationFollowOverlay.tsx` (new), `src/components/Editor.tsx`, `src/App.css` | Add the global label and target-colored outline above editor/slide/whiteboard layers.                                  | Follow state remains visible and accessible on every surface and is not conveyed by color alone. |
| 5.3  | focused suites below                                                                              | Cover content convergence, protocol, lifecycle, surface application, input cancellation, recording, and accessibility. | Targeted suites pass without a full-repository run.                                              |
| 5.4  | collaboration/deployment docs                                                                     | Replace follow-host wording, document optional teaching content and binary v3, and extend smoke/rollback procedures.   | Documentation matches the shipped boundaries and deployment coupling.                            |
| 5.5  | privacy-safe metrics                                                                              | Count aggregate follow start, target-surface transitions, and stop reasons without identifiers or content.             | Adoption and cancellation are measurable without logging room data.                              |

## Focused testing plan

### Protocol and pure helpers

- `src/collaboration/protocol.test.ts`
  - valid editor, slides, and whiteboard awareness;
  - valid bounded room-wide slide interaction with canonical sender fields supplied only by the
    server;
  - strict rejection of mixed surface fields and removed `followingHost`;
  - invalid IDs/anchors, iframe targets/data, coordinates, zoom, NaN/infinity, and unknown fields;
  - awareness states and teaching events remain below their separate limits.
- `src/collaboration/editorViewport.test.ts`
  - anchor survives concurrent insertion/deletion above the viewport;
  - offsets clamp safely;
  - missing/deleted/mismatched Y.Text returns `null`;
  - empty text file and binary transition.
- `src/collaboration/roomProvider.test.ts`
  - send/receive all binary-v3 surfaces;
  - standard selection preserved for editor and cleared for modal surfaces;
  - teaching interaction reaches all clients, including clients with no follow target;
  - duplicate event ID/sequence is applied once and viewer publication is rejected;
  - binary-v2 frame rejected cleanly.

### Shared content

- `src/collaboration/teachingDocument.test.ts`
  - seed an empty and populated deck/scene;
  - optional root is preserved by existing project projection;
  - deterministic slide order under concurrent add/delete/reorder;
  - shared current slide/build step converges under concurrent navigation;
  - stateful slide input/scroll checkpoints restore on reconnect;
  - duplicate legacy slide IDs normalized before seed;
  - `snapshotWhiteboardDelta` upserts/removals converge under concurrent update/delete and preserve
    fractional order;
  - malformed/oversized element and manifest rejection;
  - slide content bytes do not enter the Yjs snapshot.
- asset integration tests
  - upload-before-reference;
  - hash reuse, hydration, missing asset retry, and quota error;
  - room cleanup includes slide payloads.
- store-scoping tests
  - room projection never persists into the standalone key;
  - leave, room switch, provider replacement, and playback restore/reproject correctly;
  - late old-room updates cannot mutate the new scope.

### Room-wide teaching collaboration

- slide command tests
  - add/edit/delete/reorder/import from one editor appears in every client without following;
  - `slide_change` changes the shared position but never opens a closed overlay;
  - local and remote transaction origins do not echo;
  - viewer receives state and cannot publish.
- slide interaction bridge tests
  - click/focus/blur/hover/key/input/scroll target resolution and bounded validation;
  - remote apply suppression prevents capture loops;
  - stateful checkpoint restore after iframe load/reconnect;
  - stale slide/document event is ignored;
  - authored scripts remain stripped under the `allow-scripts` sandbox and nonce CSP.
- whiteboard collaboration tests
  - local mutable Excalidraw elements become cloned upserts/removals;
  - every client applies a stroke with no follow target and with its board closed;
  - hard removal versus soft-delete upsert;
  - remote element projection preserves local open state and viewport;
  - viewer cannot publish elements.

### Follow lifecycle and view components

- `src/contexts/CollaborationContext.test.tsx`
  - follow owner, editor, and viewer sessions;
  - reject self-follow and switch targets;
  - ignore unrelated/stale participant revisions;
  - leave/TTL/room cleanup;
  - reconnect suspension/resume and playback stop.
- bridge tests
  - editor → slides → whiteboard → editor;
  - deterministic repair if both overlays are open;
  - awareness-before-document and awareness-before-asset ordering;
  - newer target state cancels an older pending hydration;
  - shared slide/whiteboard changes apply when `followedSessionId` is `null` or points elsewhere;
  - programmatic changes neither cancel nor republish.
- slide tests
  - target open/close mirrors visibility only;
  - shared slide/build changes apply independently from target awareness;
  - deleted/missing slide never falls back to standalone content;
  - arrows/iframe input stop following and then publish an authorized room-wide change;
  - backdrop/close stops following without changing shared slide position.
- whiteboard tests
  - remote elements apply without following and preserve local open/viewport state;
  - followed viewport preserves shared elements;
  - `CaptureUpdateAction.NEVER` and guard prevent feedback;
  - drawing stops follow and then publishes a room delta; pan/zoom/close stay view-only.
- recording tests
  - host-visible followed slide/whiteboard transitions recorded once;
  - shared slide change/interaction and whiteboard deltas reach host recording regardless of follow;
  - a shared slide change received while the host overlay is closed does not synthesize
    `slide_open`;
  - non-host follow has no recording authority;
  - playback never publishes room content or awareness.
- accessibility tests
  - participant actions have names and pressed state;
  - global overlay announces target and surface without focus theft;
  - stop action works by keyboard on modal surfaces.

Prefer pure transition and adapter tests over mounting full Monaco or Excalidraw instances for every
case.

### Three-profile smoke test

Use two authenticated profiles plus a viewer:

1. Create a room with a custom slide, a Google SVG slide, and an existing whiteboard drawing.
2. Join all profiles without following and verify they receive identical deck and whiteboard
   content.
3. Add/edit/reorder a slide and advance its build step; verify every profile receives the change
   while closed slide overlays remain closed.
4. Interact with supported HTML-slide controls; verify every live mounted slide receives the event
   and a reconnect restores input/scroll checkpoints without replaying stale gestures.
5. Draw/move/delete whiteboard elements; verify every profile's scene advances while its local
   open/closed state and viewport remain independent.
6. Follow owner, editor, and viewer in turn.
7. Change text files, cursor/selection, vertical scroll, and long-line horizontal scroll.
8. Insert/delete text above the target viewport and verify the relative anchor stays on the same
   logical content.
9. Open/close slides and verify only followers mirror visibility while all clients retain the same
   room slide/build state.
10. Throttle one follower's asset download and verify it shows loading, then applies only the latest
    slide.
11. Open/close the whiteboard, pan, and zoom; verify only followers mirror visibility/viewport while
    drawing deltas remain room-wide.
12. Move editor → slides → whiteboard → editor rapidly and verify no obscured modal or stale
    application remains.
13. Stop from every editor, slide, whiteboard, surface-button, and first-`Escape` interaction;
    verify the authorized content action still reaches the room after follow stops.
14. Disconnect/reconnect the follower; verify follow suspension/resume plus durable teaching-state
    catch-up.
15. Reload the target; verify the old session is not followed automatically.
16. Verify a viewer receives all shared changes and can follow all surfaces but cannot publish
    project, deck, slide interaction, or whiteboard changes.
17. Record as host while another participant changes slides/interactions/drawings and while the host
    follows their visibility/view; replay both planes exactly once.
18. Leave the room and verify each profile's standalone deck/whiteboard state is restored.

## Performance, security, and privacy constraints

- Reuse one coalesced awareness path only for cursor, local surface visibility, and viewport state.
- Never put slide payloads, shared slide position, slide interactions, or whiteboard elements in
  awareness.
- Rate-limit discrete teaching-event frames separately; never coalesce away clicks, key events, or
  input changes as replaceable presence.
- Keep slide payloads out of Yjs; use private content-addressed room assets.
- Convert whiteboard element deltas to bounded Yjs changes; do not publish them as viewport
  awareness or full-scene messages.
- Do not animate each remote view update.
- Resolve editor anchors and slide IDs through existing indexes, not a full project rebuild.
- Bound whiteboard element/update/snapshot sizes before Yjs publication.
- Keep the existing viewer server guard for all durable document updates.
- Enforce viewer rejection, canonical sender identity, event dedupe, and per-sender sequence/rate
  limits for teaching-event frames.
- Continue sanitizing HTML/Markdown/Google SVG slide content. The trusted interaction bridge may
  run under a nonce, but authored scripts, forms, navigation, and network access remain blocked.
- Never log file paths, slide IDs, source URLs, asset IDs, element IDs, relative anchors,
  participant/session IDs, coordinates, zoom, source text, or raw awareness/Yjs payloads.
- Metrics may contain only aggregate counts, surface kind, and enumerated stop reason.
- A malformed surface or teaching record may reject presence/content projection but must never
  mutate an unrelated store, crash the room object, or execute code.
- Following a collaborator does not expand the existing code-execution trust boundary.

## Rollout and rollback

1. Land optional teaching-root preservation and recording-event split/convergence tests first.
2. Land shared deck/presentation and whiteboard delta projection behind disabled collaboration UI.
3. Land the sandboxed slide interaction bridge and binary-v3 room-wide event path behind a feature
   flag.
4. Verify existing schema-1 rooms without `teaching` remain readable and require explicit owner
   initialization.
5. Enable shared teaching changes first and prove they work with no follow target.
6. Land binary-v3 view awareness, follow lifecycle, and all three view adapters.
7. Deploy Worker and browser client together.
8. Run targeted tests and the three-profile smoke test against local Wrangler.
9. Enable participant `Follow` actions after shared-change, content hydration, recording, security,
   and input-cancel checks pass.

Rollback deploys the previous Worker and client together. The optional teaching Yjs subtree is
ignored but preserved by the previous project projection; room project content remains usable.
Slide assets remain private room assets and expire through normal room cleanup. If preservation is
not proven, a document schema migration is required before rollout and this rollback claim must be
revised.

## Definition of done

- [ ] Any remote online participant can be followed from the collaboration panel.
- [ ] Deck CRUD/import and shared slide/build position converge for all participants without
      following.
- [ ] Supported slide iframe interactions reach all live participants once, and stateful
      checkpoints restore after reconnect.
- [ ] Whiteboard `upserts`/`removedIds` converge for all participants, including when their boards
      are closed and no follow target exists.
- [ ] One follow session tracks editor, slides, and whiteboard surface transitions.
- [ ] Editor following tracks text file, CRDT-anchored viewport, cursor, and selection.
- [ ] Slide following controls only local open/close/maximize state; room slide changes remain
      independent of follow.
- [ ] Whiteboard following controls only local open/close/maximize and pan/zoom while shared
      elements remain independent of follow.
- [ ] Room slide/whiteboard content never overwrites standalone browser state.
- [ ] Awareness contains only bounded ephemeral view state; room content/interactions use their
      dedicated collaboration paths.
- [ ] Every documented local interaction stops following before it takes effect.
- [ ] The first `Escape` stops following without also closing the active surface.
- [ ] Programmatic application does not cancel itself, publish an echo, or apply a stale pending
      state.
- [ ] Target leave, TTL expiry, room replacement, playback, and reconnect follow the contract.
- [ ] Owners, editors, and viewers receive identical follow capability without permission changes.
- [ ] A recording host captures canonical room-wide slide/whiteboard changes plus followed visible
      view changes exactly once without changing authority or SCR3 format.
- [ ] Binary protocol v3 rejects stale clients explicitly; schema-1 project data remains usable.
- [ ] Awareness, Yjs updates, snapshots, and room assets stay within their limits.
- [ ] Targeted tests and the three-profile smoke test pass.
- [ ] Collaboration and deployment documentation describe the final behavior.

## Suggested implementation commit sequence

1. `feat(collaboration): share room teaching surfaces`
2. `feat(collaboration): stream shared slide interactions`
3. `feat(collaboration): add cross-surface view awareness`
4. `feat(collaboration): follow any participant across surfaces`
5. `test(collaboration): cover teaching collaboration and following`
6. `docs(collaboration): document teaching collaboration and following`
