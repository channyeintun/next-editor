# Scrimba Action Protocol Notes

Last updated: 2026-06-14

Source: `tmp/chunks/ide.36BDFLCO.js`

## Confirmed Protocol Shape

Each stream action is represented by an array. The first array element is a numeric action code. `IDEStreamAction.deserialize(e,t)` dispatches using an opcode map (`hd[e[0]]`). The decorator/helper `Ve(...)` assigns:

- `type` on the action constructor and prototype.
- `strategy` and `diff` options.
- optional `schema` accessors.
- the constructor into the opcode map.

Evidence anchors:

- Opcode map starts near character offset `566697`.
- `Ve(...)` helper starts near character offset `569461`.
- `IDEStreamAction.deserialize` starts near character offset `2293694`.
- `IDEStream.parsedValue`, `syncBuffer`, and `write` are in the `IDEStream` class, bundle segment offset around `2402588-2404862`.

## Stream Framing Found So Far

High confidence from `IDEStream`:

- The stream is unpacked with `OP.msgpack.createUnpacker()`.
- `syncBuffer` reads new bytes from `this.stream.chunked.slice(previousReadableOffset, readableSize)` and calls `unpacker.unpackMultiple`.
- Decoded values are handled by `parsedValue(value, byteOffset, localFlag, previousValue)`.
- Numeric decoded values are control/timing markers:
  - positive large values above `16e11` are treated as absolute timestamps.
  - positive smaller values are treated as time deltas and increase the current timestamp/offset.
  - negative values set `lastType` to the next action type (`lastType = -value`).
- Non-numeric decoded values are interpreted as payloads for the current `lastType`.
- `write(action, options)` emits:
  - an absolute timestamp for the first write, or a compact time delta for later writes.
  - a negative action type marker when the action type changes.
  - the action's encoded payload.
- `parsedValue` decodes the payload through the registered action class, attaches byte offset/raw value, adds it to branch arrays, updates text-edit/significant-action indexes, and calls `commitToStream`.

Medium confidence:

- Persisted stream bytes are msgpack-framed sequences containing timing markers, type markers, and compact payload arrays.
- Action offsets represent elapsed timeline time, while byte offsets represent stream byte positions used for trimming/rollback.

## Opcode Map

Extracted from the bundle:

| Code | Name                 |
| ---: | -------------------- |
|    1 | `SET`                |
|    2 | `PATCH`              |
|    3 | `WIDGET_CREATE`      |
|    4 | `LCINSERT`           |
|    5 | `LCDELETE`           |
|    6 | `LCEDIT`             |
|    7 | `LCSELECTION`        |
|    8 | `LAYOUT`             |
|    9 | `BROWSER_LAYOUT`     |
|   10 | `NODE_LAYOUT`        |
|   12 | `POINTER_UPDATE`     |
|   13 | `SYNC`               |
|   16 | `CONSOLE_LOG`        |
|   17 | `CONSOLE_CLEAR`      |
|   18 | `CONSOLE_VAL_EXPAND` |
|   21 | `DOM_MUTATE`         |
|   22 | `DOM_EVENT`          |
|   23 | `DOM_SCROLL`         |
|   24 | `DOM_SELECTION`      |
|   25 | `DOM_FOCUSIN`        |
|   26 | `DOM_HOVERIN`        |
|   27 | `DOM_ACTIVEIN`       |
|   28 | `PAGE_LOAD`          |
|   29 | `PAGE_LOADED`        |
|   30 | `PAGE_LOG`           |
|   31 | `PAGE_REQUEST`       |
|   32 | `PAGE_HISTORY`       |
|   33 | `RECSTART_OLD`       |
|   34 | `RECSTOP_OLD`        |
|   35 | `PING`               |
|   36 | `SNAPSHOT`           |
|   37 | `FORK`               |
|   38 | `BRANCH`             |
|   39 | `TRIM`               |
|   40 | `KEYFRAME`           |
|   42 | `OPSNAPSHOT`         |
|   43 | `OPDELTA`            |
|   44 | `OPROLLBACK`         |
|   50 | `PAGE_UNLOAD`        |
|   61 | `PROCESS_LOG`        |
|  100 | `LOCK`               |
|  101 | `UNLOCK`             |
|  110 | `FS_RENAME`          |
|  111 | `FS_REMOVE`          |
|  112 | `FS_MOVE`            |
|  126 | `WIDGET_FLAG`        |
|  127 | `WIDGET_UNFLAG`      |
|  128 | `WIDGET_APPEND`      |
|  129 | `WIDGET_REMOVE`      |
|  200 | `SIM_BUILD`          |
|  201 | `SIM_RESULT`         |
|  202 | `DOM_FOCUSOUT`       |
|  203 | `DOM_HOVEROUT`       |
|  204 | `DOM_ACTIVEOUT`      |
|  206 | `DOM_INSERT`         |
|  207 | `DOM_RESET`          |
|  210 | `LCSCROLL`           |
|  220 | `COMMIT`             |
|  221 | `SAVE`               |
|  222 | `SEED`               |
|  223 | `EVALUATE`           |
|  224 | `CALL`               |
|  241 | `MSR_START`          |
|  242 | `MSR_CHUNK`          |
|  243 | `MSR_END`            |
|  250 | `VIEW_OPEN`          |
|  251 | `VIEW_CLOSE`         |
|  252 | `VIEW_MOVE`          |
|  253 | `VIEW_PIN`           |

## Target IDs

The same opcode section defines negative target IDs:

|  ID | Target           |
| --: | ---------------- |
|  -1 | `WORKSPACE`      |
|  -2 | `CONSOLE`        |
|  -3 | `SIMULATOR`      |
|  -4 | `INSPECTOR`      |
|  -5 | `AGENT`          |
|  -6 | `STREAM`         |
|  -7 | `BROWSER`        |
|  -8 | `FS`             |
|  -9 | `PRIMARY_EDITOR` |
| -10 | `EXPLORER`       |
| -11 | `DEPENDENCIES`   |
| -12 | `SLIDES`         |
| -13 | `SIDEBAR`        |
| -14 | `POINTER`        |
| -15 | `SCM`            |

The list continues after the extracted snippet and should be extended in a later pass.

## DOM Mutation Subprotocol

`BrowserPage.applyMutations` uses a separate DOM mutation enum (`ro.MUTS`):

| Code | Mutation          |
| ---: | ----------------- |
|    1 | `RESET`           |
|    2 | `INSERT`          |
|    3 | `REMOVE`          |
|    4 | `INIT`            |
|    5 | `INSERT_AFTER`    |
|    6 | `INSERT_ADJACENT` |
|   10 | `SETATTR`         |
|   11 | `SETPROP`         |
|   12 | `SETTEXT`         |
|   13 | `REFLOW`          |

Known attribute/property name aliases:

| Code | Name      |
| ---: | --------- |
|    1 | `class`   |
|    2 | `value`   |
|    3 | `checked` |
|    4 | `style`   |

Known insert-adjacent positions:

- `beforebegin`
- `afterbegin`
- `beforeend`
- `afterend`

## Action Semantics Found So Far

### Text Actions

`TextEditAction` (`LCEDIT=6`) applies text model edits and restores previous selection on revert.

`TextInsertAction` (`LCINSERT=4`) is significant and stores:

- target id in `params[0]`
- start line/column or range data in `params[1]`/`params[2]`
- inserted string in `params[3]`
- optional `selAfter` in `params[4]`

It can compact adjacent inserts by encoding only the inserted string when the previous insert's post-selection equals the next insert start.

`TextDeleteAction` (`LCDELETE=5`) is significant and stores a deletion range in `params[1..4]`, with optional `selAfter` in `params[5]`.

`TextSelectionAction` (`LCSELECTION=7`) can compact repeated selections by storing only the changed suffix.

### Snapshot And Keyframe

`SnapshotAction` (`SNAPSHOT=36`) loads widget/workspace serialized state. It:

- assigns widget state into branch read state during stream commit.
- deserializes widgets in parent-before-child order.
- skips widgets of type `audio` during widget deserialization.
- restores prior widget data on revert.

`KeyframeAction` (`KEYFRAME=40`) subclasses `SnapshotAction`.

### Browser/Page Actions

`PageLoadAction` (`PAGE_LOAD=28`) creates or selects a `BrowserPage`, assigns HTTP status and URL, updates `IDEBrowser.page`, and clears the console.

`PageLoadedAction` (`PAGE_LOADED=29`) uses `dedupe` strategy and sets the page initial state when first applied.

`PageLogAction` (`PAGE_LOG=30`) also uses `dedupe`. It pushes/pops console log entries and suppresses the in-browser Babel transformer warning.

`DOMMutateAction` (`DOM_MUTATE=21`) calls `BrowserPage.applyMutations` and records errors on the target page.

`DOMSelectionAction`, `DOMFocusInAction`, `DOMHoverInAction`, and `DOMActiveInAction` update page selection/focus/hover/active state and revert to prior state.

### File/View Actions

`FSMoveAction` (`FS_MOVE=112`) moves an entry between parent directories and reverts by restoring the previous parent.

`FSRemoveAction` (`FS_REMOVE=111`) removes a target entry.

`ViewOpenAction` (`VIEW_OPEN=250`) pushes a widget/file into an editor group, marks it opened, and closes the oldest unpinned view when needed.

`ViewCloseAction` (`VIEW_CLOSE=251`) removes a widget/file from the group and reopens the previous active view when appropriate.

`SaveAction` (`SAVE=221`) records the target's `lastSave`, stores current contents into the target body, and has a `scrim-save-marker`.

### Cursor/Playback

`IDEStreamCursor` maintains:

- current branch
- current action
- current target
- stack of currently applying/reverting actions
- branch path for cross-branch routing

To seek, it compares the current action and target action, reverts to the nearest shared point, then applies actions forward. If a route crosses branches, it follows branch-specific first/next action links. After sync, marked targets receive `synced_` callbacks if present.

## Implementation Implications

For a Scrimba-like system, the core engine needs:

1. A compact typed action protocol.
2. A reversible application model for each target domain.
3. Periodic snapshots/keyframes for fast recovery and bounded seek cost.
4. A cursor capable of branch-aware apply/revert traversal.
5. Deterministic preview capture/replay, including DOM mutations and console logs.
6. Separate media/caption timeline synchronization.

## Open Protocol Questions

- What exact binary framing/compression wraps these action arrays in persisted stream files?
- Where are action offsets and byte offsets serialized/deserialized?
- How are media stream chunks (`MSR_*`) stored and linked to `ScrimRec`/`ScrimClip`?
- What server endpoints serve `ScrimStream.httpUrl` and `/legacy/files/`?
- How are branch markers and commit offsets encoded in persisted `Scrim` records?
