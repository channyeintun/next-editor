# Review: `src/monaco` vs `migration-plan.md` — 2026-07-10

Reviewed against the revised migration plan. Scope: all 7 files in
`src/monaco/`, plus the two consumers (`src/components/CodeEditor.tsx`,
`src/components/preview/ApiClientPanel.tsx`) and the removal checklist.
(The previous 2026-07-06 `src` review this file held is preserved in git history.)

**Verdict: the migration is structurally faithful to the plan** — single
HMR-safe runtime init, `MonacoEditor` owns no models and no theme,
`automaticLayout: false` is enforced internally at both `create` and every
`updateOptions`, `setActiveTheme` is the only app-facing theme call, the
wrapper is fully removed (`rg "@monaco-editor/react"` over `src`,
`package.json`, `bun.lock` returns nothing, and `monacoSetup.ts` /
`editorConstants.ts` / `editorModels.ts` are gone). Typecheck passes.
One high-severity bug and a handful of smaller gaps remain, listed below.

---

## F1 — HIGH: `useOwnedModel` is not StrictMode-safe; API-client editors mount with a disposed model in dev

`src/monaco/useOwnedModel.ts:14-18, 36-45` · violates plan §4/§10 checklist
("idempotent … including under a StrictMode double-invoke") and §11.

The app renders under `<StrictMode>` (`src/main.tsx:12`). Model **creation**
happens in the render phase, but **disposal** happens in an effect cleanup.
StrictMode's dev-only effect double-invoke runs _all_ cleanups, then _all_
setups, with **no re-render in between**:

1. Mount: render creates model `M`; `MonacoEditor` creates an editor attached to `M`.
2. StrictMode cleanup pass: `MonacoEditor` disposes the editor; then the
   `[uri]` cleanup disposes `M` and nulls `modelRef`.
3. StrictMode setup pass: `MonacoEditor`'s layout effect re-runs
   `monaco.editor.create(container, { ...options, model })` — with the same,
   now-disposed `M` prop. Nothing re-created it, because creation lives in
   render and no render occurred.

Monaco asserts on attach: `TextModel._assertNotDisposed()` throws
`BugIndicatingError('Model is disposed!')`
(`node_modules/monaco-editor/esm/vs/editor/common/model/textModel.js:259-261`;
the attach path in `codeEditorWidget.js:1243-1252` reads model state
immediately). So in dev, mounting either `ApiClientPanel` editor should crash
the panel. Production builds are unaffected (StrictMode double-invoke is
dev-only), which is probably why this hasn't surfaced.

`CodeEditor` survives the same cycle only because workspace models are
deliberately never disposed on unmount. But it has one narrow variant of the
same bug: `detachEditorOnUnmount` (`CodeEditor.tsx:301-322`) runs
`disposePlaybackModels(monaco)` with no preserved URI during the StrictMode
cleanup pass, so mounting `CodeEditor` _while already in playback mode_ would
re-create the editor against a disposed playback model.

**Suggested fix direction:** two complementary changes —

- Make `MonacoEditor` defensive: if `model.isDisposed()` at creation (or in
  the `[model]` effect), create the editor without a model / skip `setModel`.
  Child layout effects always fire before parent effects, so the child can
  never be fully protected by the parent alone.
- Move owned-model creation/disposal into a `useLayoutEffect` keyed by the
  parsed URI, holding the model in state (render `MonacoEditor` only when
  non-null). The StrictMode setup pass then re-creates the model and the
  state update re-attaches it.

A StrictMode-remount test for `useOwnedModel` (plan Verification Checklist)
would have caught this — see F7.

## F2 — MEDIUM: view state is lost on text → binary transitions

`src/components/CodeEditor.tsx:374-381` · violates plan §7 ("Also save the
current normal model view state … before the editor is disposed for a
binary-file transition") and the smoke-test item "text → binary → text …
previous view state is restored".

When `isBinaryActiveFile` flips true, `MonacoEditor` unmounts. Its layout
cleanup disposes the editor **during the commit phase**, before `CodeEditor`'s
passive `[isBinaryActiveFile]` effect runs `saveNormalViewState(editorRef.current)`.
On a disposed editor `getModel()` returns `null`, so `saveNormalViewState`
early-returns at `CodeEditor.tsx:280` and nothing is saved. Cursor/scroll are
silently lost every time the user views a binary asset and comes back.

Note the save isn't reachable by any earlier hook either: text→binary doesn't
go through `setModel`, so `onBeforeModelChange` never fires.

**Suggested fix:** have `MonacoEditor` invoke a callback from its cleanup
_before_ `editor.dispose()` (e.g. call `onBeforeModelChange(editor, currentModel)`
on unmount, or add a dedicated `onWillDispose` prop), and hook
`saveNormalViewState` there. The same hook also makes the true-unmount save in
`detachEditorOnUnmount` actually see a live editor (harmless today only
because `viewStatesRef` dies with the component anyway).

## F3 — LOW/MEDIUM: model mutation during the render phase

`src/monaco/useOwnedModel.ts:14-18` and `src/components/CodeEditor.tsx:124-147`.

`useOwnedModel` creates/disposes models in render; `CodeEditor`'s `activeModel`
`useMemo` calls `syncWorkspaceModel`/`syncPlaybackModel`, which can `setValue`
a _shared, globally-registered_ model — a side effect in render. React is free
to discard or replay renders (and with `"use no memo"` the memo is the only
cache), so a thrown-away render still mutates the model service. Today the
next committed render re-syncs and hides it, but it's the same hazard class as
F1 and worth consolidating when F1 is fixed (do the sync in an effect, or at
minimum keep it idempotent-only: create-if-missing in render, `setValue` in an
effect).

## F4 — LOW: second `monaco.editor.setTheme` call site in `runtime.ts`

`src/monaco/runtime.ts:76` calls `monaco.editor.setTheme(NEXT_EDITOR_MONACO_THEME)`
directly. The plan's theme invariant (§"theme.ts" and Verification Checklist)
is "`setActiveTheme` is the only function in the codebase that calls
`monaco.editor.setTheme`". The init-time call itself is right (it's the fix
for the default-theme white flash, commit 9a82726) — just route it through
`setActiveTheme(NEXT_EDITOR_MONACO_THEME)` so the invariant is grep-true and
the checklist assertion can be automated.

## F5 — LOW: `updateOptions` runs on every parent render

`src/monaco/MonacoEditor.tsx:100-102` keys the options effect on object
identity. `CodeEditor` passes `getEditorOptions(isPlaying)` (fresh object per
render, and it re-renders on every keystroke via `activeFile.content`);
`ApiClientPanel` passes inline literals. So `editor.updateOptions` runs on
every keystroke/store update. Monaco diffs internally, so this is waste rather
than breakage — but the plan's contract is "on `options` prop change". Either
memoize at the call sites (`useMemo(() => getEditorOptions(isPlaying), [isPlaying])`
is fine in the uncompiled `CodeEditor`; hoist the API-panel literals to module
constants) or shallow-compare inside `MonacoEditor`.

## F6 — LOW: playback-URI knowledge duplicated outside `models.ts`

`src/components/CodeEditor.tsx:280,289` hardcode
`"file:///__next-editor__/playback/"` twice, while `models.ts` keeps
`PLAYBACK_MODEL_ROOT` and `isPlaybackModelUri` private (`models.ts:4,15-17`).
The plan assigned "view-state helpers" to `models.ts` (§1, §"models.ts").
Export `isPlaybackModelUri` (or the save/restore helpers themselves) so the
prefix has one owner.

Related latent trap: `workspacePathFromMonacoModelUri` (`models.ts:76-84`)
only excludes the playback root, so the API-client URIs
(`file:///__next-editor__/api-client/…`) _would_ resolve to writable workspace
paths if ever passed through it. Nothing does today (it only sees the main
editor's models), but excluding the whole `file:///__next-editor__/` reserved
root would make that structural instead of coincidental.

## F7 — MEDIUM (coverage): planned package tests are missing

Plan implementation-order steps 3 and 6 + Verification Checklist. Present:
`models.ts` is well covered by `src/components/editorModels.test.ts` (which
deliberately deep-imports `../monaco/models` to avoid booting the runtime in
node — good; consider relocating it to `src/monaco/models.test.ts` to live
with what it tests). Missing entirely:

- `MonacoEditor` lifecycle tests (idempotent disposal incl. StrictMode,
  `setModel` callback ordering, `automaticLayout` enforcement, never disposing
  a model).
- `useOwnedModel` tests (create/dispose on URI change + unmount, conditional
  `setValue`, `setModelLanguage`) — these would have caught F1.
- The plan's step-3 decision (browser-mode vs Playwright CT for Monaco-backed
  tests) appears unresolved; there's no test environment in the repo that can
  run `editor.create`.

## F8 — LOW (docs): stale wrapper-era comments

Plan §2: "Update comments so they describe direct Monaco initialization."
`CodeEditor.tsx:97-102` still justifies `"use no memo"` with "the theme is
registered in `beforeMount`" and "render-to-render flow of the `<Editor>`
props" — both describe the deleted wrapper (theme registration now happens
once in `runtime.ts`). `CodeEditor.tsx:372` says "The Monaco `<Editor>`
unmounts". Reword so the compiler opt-out rationale reflects the current
direct-Monaco integration (or re-evaluate whether the opt-out is still needed
now that `beforeMount` is gone — that's a behavior question, so verify in the
running app before touching it).

---

## Plan conformance snapshot

| Plan requirement                                                                                                                                                                                  | Status                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 package layout + `index.ts` export surface                                                                                                                                                     | ✅ matches plan exactly                                                                                                                        |
| §2 single global-flagged init (theme, TS defaults, workers, HMR-safe)                                                                                                                             | ✅ (`runtime.ts:64-80`)                                                                                                                        |
| §3 wrapper types replaced                                                                                                                                                                         | ✅ no `@monaco-editor/react` types anywhere; remaining `import type * as monaco from "monaco-editor"` in `src/core` are type-only and harmless |
| §4 `MonacoEditor`: no model create/dispose, no theme prop, `automaticLayout` forced, single `onDidChangeModelContent`, ResizeObserver + initial `layout()`, callback ordering, idempotent cleanup | ✅                                                                                                                                             |
| §5 `CodeEditor` uses package; `setActiveTheme` only there; no re-init on mount                                                                                                                    | ✅ (`CodeEditor.tsx:347-349`; init not re-run)                                                                                                 |
| §6 `syncWorkspaceModel` parity, `isApplyingExternalModelValueRef` carried over and wired                                                                                                          | ✅ (`CodeEditor.tsx:113,135-140,191,200`)                                                                                                      |
| §7 view-state save/restore excl. playback                                                                                                                                                         | ⚠️ file-switch path ✅; binary transition ❌ (F2)                                                                                              |
| §8 event wiring + guards preserved                                                                                                                                                                | ✅ all five listeners + playback/binary guards present                                                                                         |
| §9 layout via internal ResizeObserver                                                                                                                                                             | ✅                                                                                                                                             |
| §10 disposal ownership split                                                                                                                                                                      | ⚠️ ✅ for `MonacoEditor`/`CodeEditor`; ❌ `useOwnedModel` under StrictMode (F1)                                                                |
| §11 `ApiClientPanel` on package primitive, no `setActiveTheme`                                                                                                                                    | ✅ (theme race resolved by construction) — but F1 applies                                                                                      |
| §12 wrapper removed from deps/lock                                                                                                                                                                | ✅                                                                                                                                             |
| Tests from Verification Checklist                                                                                                                                                                 | ⚠️ `models.ts` ✅; `MonacoEditor`/`useOwnedModel` ❌ (F7)                                                                                      |

## Verification runs

- `bun run typecheck` — ✅ clean.
- `npx vp test run` — 389/390 pass. The one failure
  (`src/components/preview/rrwebPreview.test.ts` — replay-clock rebase) is in
  the rrweb replay timeline, **unrelated to this migration**, and fails on a
  clean working tree, i.e. pre-existing on `main`.
- Not verified here: browser behavior (per project convention, tsc + tests
  only; UI is eyeballed by the user). F1 predicts a visible dev-mode failure
  when opening the API-client body/response editors — worth checking first.

## Suggested fix order

1. F1 (dev crash) together with F3 (same root cause: model lifecycle in render).
2. F2 (silent UX regression, small `MonacoEditor` API addition).
3. F7 tests alongside 1–2 to lock them in.
4. F4, F5, F6, F8 as a single small cleanup pass.
