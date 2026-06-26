# Plan: Subtitles / Captions Feature

Add closed-caption support to recordings: a styled caption line that plays over the
editor surface in sync with the timeline, a **CC** toggle (with a language menu when
more than one track exists), and **import of `.vtt` / `.srt` caption files** as the
authoring source.

The design is modeled on the reference implementation found in `tmp/` (Scrimba's IDE
bundle) and adapted to this project's architecture (XState recorder machine, SCR3
container, overlay-over-`editor-surface` pattern).

### Architecture rule: reuse existing XState deps, don't hand-roll

Before adding any new hook, context, or `localStorage`+`CustomEvent` plumbing, check the
patterns already in the codebase and use them:

- **UI preference state** (CC on/off, selected language) → a small store built with
  `@xstate/store-react` `createStore`, exactly like `src/stores/runtimePanelStore.ts` /
  `slidesStore.ts` / `workspaceStore.ts` (`context` + `on:` handlers + `selectX`
  selectors + a `…StoreContext`, consumed via `useSelector`). **Not** a bespoke
  `localStorage` + `window.dispatchEvent(CustomEvent)` channel.
- **Recording data mutations** (`addCaptionTrack` / `removeCaptionTrack`) → events on
  the existing `editorMachine` (it already owns `recording` and exposes mutations like
  `loadRecording` / `extendRecording`). **Not** a second source of truth.
- **Timeline sync** → the existing `useLiveTime()` machine selector. No new ticker.

This supersedes the `CameraOverlay`-style `localStorage`/event pattern referenced in the
draft below — `CameraOverlay` predates the store convention; new code should follow the
store convention instead.

---

## 1. How the reference (`tmp/`) does it — for context

- `ide-clip-captions` custom element renders a `caption-line` box containing one
  `<span>` per **word**; a `tick()` driven by `currentTime` flags the active word
  `current` (karaoke highlight). Previous words read `.played`, upcoming words are
  dimmed. Lines break after a word ending in `.` (or `,` with a >600 ms gap).
- Caption data is **word-timed** and attached per audio clip
  (`clip.src.captions.parts`, each part `[start, end]` + `.body`).
- The **CC** button is `caption-toggle` (an op-button): `press` flips a global
  `APP.settings.cc`; an `opmenu` opens the language dropdown; `.active` when on.
- Styling (`caption-line`): centered, `#071017e0` bg, 1px translucent white border,
  `backdrop-filter: blur(10px)`, 24 px text, words fade `.55 → .82 → 1`.

**Our adaptation:** `.vtt`/`.srt` import gives us **cue-level** (phrase) timing, not
per-word timing. So the MVP highlights the **active cue** (whole phrase) — which already
matches the screenshot's visible single line. Per-word karaoke highlight is kept as an
optional Phase 5 enhancement (only possible when a track carries word timings).

---

## 2. Data model

Add a captions channel to `Recording`. Cue-level, with optional word timings so we can
grow into karaoke highlighting later without a schema break.

```ts
// src/core/src/types.ts (new, exported)
export interface CaptionWord {
  start: number; // ms, relative to recording origin
  end: number; // ms
  text: string;
}

export interface CaptionCue {
  start: number; // ms, relative to recording origin
  end: number; // ms
  text: string; // full cue text (may contain a soft newline)
  words?: CaptionWord[]; // optional per-word timing for karaoke highlight
}

export interface CaptionTrack {
  id: string;
  language: string; // BCP-47 tag, e.g. "en", "ar", "bn", "de", "es", "fr"
  label?: string; // display name, e.g. "English", "Arabic (العربية)"
  cues: CaptionCue[];
  default?: boolean;
}
```

Then on `Recording` (`src/core/src/types.ts` around line 181, next to `cursorEvents`):

```ts
  captions?: CaptionTrack[];
```

Cues are stored **sorted by `start`** and on the same timeline origin as everything
else (ms from recording start), so playback is a binary-search lookup against
`useLiveTime()`.

---

## 3. Persistence (SCR3 + IndexedDB)

Captions are small JSON — ride them in the container **meta** (msgpack), the same path
`slides` / `workspaceSnapshot` already use. No new segment kind needed.

- `src/storage/streamingRecordingCodec/format.ts` — add `captions?: CaptionTrack[]` to
  `RecordingStreamMeta` (next to `slides`, ~line 105).
- `src/storage/streamingRecordingCodec/encode.ts` — map `normalized.captions` into meta
  (next to `slides: normalized.slides`, ~line 322).
- `src/storage/streamingRecordingCodec/decode.ts` — read `captions: meta.captions` back
  onto the `Recording` (next to `slides: meta.slides`, ~line 180).
- `src/storage/recordingCodec.ts` — confirm round-trip; extend
  `recordingCodec.test.ts` with a captions round-trip case.
- IndexedDB store (`src/storage/IndexedDBRecordingStore.ts`) stores the whole
  `Recording` object, so captions persist automatically once on the type — verify, no
  schema bump expected.

Backwards compatibility: field is optional; older recordings simply have no `captions`.

---

## 4. Import: `.vtt` / `.srt` → `CaptionTrack`

New module `src/captions/parseCaptions.ts` (zero-dep, ~150 LOC) + unit test:

- `parseVtt(text): CaptionCue[]` — handle `WEBVTT` header, `HH:MM:SS.mmm --> HH:MM:SS.mmm`
  cue timings, multi-line cue text, blank-line separators; ignore `NOTE`/`STYLE` blocks
  and cue identifiers. Strip simple inline tags (`<c>`, `<v>`, `<00:00:01.000>`); if
  inline `<timestamp>` tags are present, optionally capture them as `words[]`.
- `parseSrt(text): CaptionCue[]` — numeric index lines, `HH:MM:SS,mmm --> ...` (comma
  ms), multi-line text.
- `detectAndParse(filename, text): CaptionCue[]` — choose by extension/content.
- Normalize: sort by `start`, clamp negatives, drop zero/negative-duration cues.

Offset handling: VTT/SRT timestamps are relative to the media start. Align to the
recording origin using `audioStartOffsetMs` if the captions track the audio. Default
assumption: caption `00:00:00` == recording `0` (document this; add an offset control
later if needed).

UI entry point — an **"Import captions…"** action that opens a hidden file input
(`accept=".vtt,.srt,text/vtt,application/x-subrip"`), mirroring the existing audio-file
input pattern in `MediaControls.tsx` (`audioFileInputRef`, `handleAudioFileChange`).
On select: parse → build a `CaptionTrack` (ask for / infer language) → attach to the
current recording via a new action (see §6). Importing a second file with a different
language adds another track (enables the language menu).

---

## 5. Playback overlay component

New `src/components/CaptionsOverlay.tsx`, rendered inside the `editor-surface` container
in `Editor.tsx` (sibling of `CameraOverlay`, ~line 41), so it sits above the editor and
under the controls.

- Subscribe to `useLiveTime()` (high-frequency tick selector) — same hook the
  progress/timer already use, so no machine changes for playback.
- Pick the active track: selected language (see §6) else the `default` track else first.
- Binary-search the active cue for `currentTime` (cues are sorted); render nothing when
  no cue is active or CC is off.
- Render a `caption-line`-style box: centered near the bottom of the surface, dark
  translucent bg, blurred backdrop, large readable text. Port the reference CSS values.
- Enabled state + selected language come from the **caption store** (§6) via
  `useSelector`, _not_ from `localStorage`/`CustomEvent`. The store owns persistence.
- RTL: set `dir="rtl"` when the selected language is RTL (e.g. `ar`) so Arabic renders
  correctly.
- Mobile: smaller font (the reference drops 24px→18px under a breakpoint).
- (Phase 5) If the active cue has `words[]`, split into spans and flag the
  `current` word from `currentTime`, with `.played` on passed words — the karaoke
  effect from the screenshot.

---

## 6. Controls: CC toggle + language menu

**Caption preference store** — new `src/stores/captionStore.ts` built with
`@xstate/store-react` `createStore`, following `runtimePanelStore.ts` to the letter
(`context` + `on:` handlers + `selectX` selectors), exposed through a
`CaptionStoreContext` and consumed with `useSelector`:

```ts
interface CaptionContext {
  enabled: boolean;
  language: string | null;
}
// on: { setEnabled, toggleEnabled, setLanguage }
// selectors: selectCaptionsEnabled, selectCaptionLanguage
```

Persistence: hydrate the initial `context` from `localStorage` and persist on change via
a single `store.subscribe(...)` (same approach `workspaceStore` uses for its sidebar
prefs) — the store is the one owner of the keys, no events:

- `caption-enabled` — CC on/off.
- `caption-language` — selected BCP-47 tag (the hinted key name).

In `src/components/MediaControls.tsx`, add a **CC** button in the transport row
(near the camera/settings buttons, only shown when `currentRecording` has ≥1 caption
track), matching the screenshot's bottom-right placement.

- Click `trigger.toggleEnabled()` on the caption store. Active styling like the
  reference `caption-toggle.active`, driven by `useSelector(selectCaptionsEnabled)`.
- When the recording has **>1 track**, the button also opens a small popup menu (reuse
  the existing settings-popup markup at `MediaControls.tsx:447`) listing each track's
  `label`/`language` with the selected one checked — the screenshot's
  English/Arabic/Bengali/German/Spanish/French menu. Selecting one calls
  `trigger.setLanguage(tag)`.
- Single-track recordings: button is a plain on/off toggle (no menu).

**Recording-data mutations** live on the `editorMachine` (it owns `recording`), surfaced
through the existing actions context alongside `loadRecording` / `extendRecording` —
_not_ in the caption store:

- `addCaptionTrack(track: CaptionTrack)` — machine event that attaches/replaces a track
  on the current recording and re-saves through the existing storage path.
- `removeCaptionTrack(id: string)` — machine event.

Wire them through `editorMachine.ts` (new `on:` events + `assign` updating
`context.recording.captions`) → `useNextEditor.ts` → actions context →
`NextEditorProvider.tsx`, mirroring how `loadRecording` is plumbed today.

---

## 7. Authoring affordance (where import lives)

Surface "Import captions…" where recordings are managed — most naturally in
`EditorHeader.tsx` (it already owns export/`.ne` actions) and/or the `MediaControls`
settings popup. Minimum: a menu item that triggers the §4 file input. A full in-app cue
editor is **out of scope** (user chose import-only).

---

## 8. Testing

- `parseCaptions.test.ts` — VTT and SRT fixtures: headers, comma vs dot ms,
  multi-line cues, NOTE/STYLE skipping, malformed input, ordering/clamping.
- `recordingCodec.test.ts` — captions survive SCR3 encode → decode round-trip.
- Overlay logic — active-cue selection (binary search) across boundaries, empty gaps,
  track selection / fallback, CC off.
- `tsc` clean; run with `npx vp test run` (per project convention — not bare vitest).
- Manual: user eyeballs the overlay (no Claude preview browser per project rule).

---

## 9. Phasing

1. **Model + persistence** — types, SCR3 meta encode/decode, round-trip test.
2. **Parser** — `parseCaptions.ts` + tests (VTT, SRT).
3. **Import wiring** — file input + `addCaptionTrack` action, attach to recording.
4. **Playback overlay** — `CaptionsOverlay` + `Editor.tsx` mount, `useLiveTime` sync,
   `caption-line` styling, CC enabled/visibility plumbing.
5. **Controls** — `captionStore` (`@xstate/store-react`) + CC button + language menu in
   `MediaControls`, RTL, and (stretch) per-word karaoke highlight when `words[]` exist.

Phases 1–4 deliver a working single-track captions feature; Phase 5 adds the
multi-language menu and word-level highlight to fully match the screenshot.

---

## 10. Open decisions

- **Language tagging on import:** infer from filename suffix (e.g. `*.en.vtt`,
  `*.ar.srt`) and/or VTT `Language:` header, else prompt. _Recommend: infer, fall back
  to a small prompt._
- **Caption ↔ audio offset:** assume `0 == recording origin` for v1; add an offset
  nudge control only if drift shows up in practice.
- **Karaoke highlight (Phase 5):** only when a track has real `words[]` (rare in plain
  SRT/VTT). Optionally synthesize word timings by splitting a cue evenly across its
  duration — _flagged as optional, off by default._
