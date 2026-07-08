# Migration Plan: Create a Reusable Monaco Package and Replace `@monaco-editor/react`

_Revised after review — see "Changes in this revision" below._

## Goal

Create a reusable local Monaco package for this project, then move all editor surfaces from the inactive React wrapper to that shared package. The migration must preserve the current self-hosted Vite worker setup, custom theme, TypeScript defaults, multi-file models, playback models, save behavior, and recording/replay event hooks.

Primary upstream references:

- Monaco ESM integration guide: https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md
- Monaco Vite React sample worker setup: https://github.com/microsoft/monaco-editor/blob/main/samples/browser-esm-vite-react/src/userWorker.ts
- Monaco `editor.create` API: https://microsoft.github.io/monaco-editor/typedoc/functions/editor_editor_api.editor.create.html
- `monaco-editor` home/API site, currently showing the latest released editor package as `0.55.1`: https://microsoft.github.io/monaco-editor/
- `@monaco-editor/react` npm page, currently showing the separate React wrapper package as latest `4.7.0`, last published about a year ago: https://www.npmjs.com/package/%40monaco-editor/react

## Changes in this revision

1. **Single source of truth for runtime init.** Theme registration and TypeScript defaults are configured exactly once, inside `runtime.ts`, guarded so it survives React StrictMode remounts and Vite HMR reloads. `CodeEditor.tsx` no longer re-calls `defineNextEditorTheme`/`configureMonacoTypeScript` on mount.
2. **`automaticLayout: false` is enforced inside `MonacoEditor.tsx` itself**, not left to call sites to remember. A caller can no longer accidentally reintroduce the dual-layout bug.
3. **Theme is no longer a per-instance prop.** `monaco.editor.setTheme` is a page-global call, so exposing `theme` on `MonacoEditorProps` created a real race between `CodeEditor` and `ApiClientPanel`. Theme is now set exclusively through a single package-level `setActiveTheme`, called only by `CodeEditor`.
4. **`MonacoEditor` no longer creates or disposes models.** Model ownership (and the "sync value only if it differs" / language-update logic) moves entirely to callers: `models.ts` helpers for workspace/playback models, and a new `useOwnedModel` hook for simple embedded editors like the ones in `ApiClientPanel`. This shrinks `MonacoEditor`'s job to "attach whatever model I'm given," removes the owned-vs-parent-owned branching, and makes double-disposal structurally impossible rather than something an ownership check has to get right.
5. **Removed the unused `preserveViewState` prop.** The original API sketch included it, but the actual view-state logic in `CodeEditor.tsx` is fully handled through `onBeforeModelChange`/`onAfterModelChange` callbacks — the prop was never referenced again in the plan and would have been dead weight.
6. **`isApplyingExternalModelValueRef`** is called out as an implementation decision rather than a vague future fallback: confirm whether it already exists during step 2, carry it over if it does, or add it when wiring `syncWorkspaceModel` if programmatic `setValue` needs suppression.
7. **Added an explicit test-environment decision** to the implementation order, before any `MonacoEditor` lifecycle tests are written. Monaco doesn't run meaningfully under plain jsdom (workers, layout measurement), so this needs to be settled early rather than discovered mid-implementation.

## Current State

- `package.json` already includes both packages: the React wrapper `@monaco-editor/react` and the actual editor runtime `monaco-editor`. `monaco-editor` is currently `^0.55.1`.
- `src/components/monacoSetup.ts` already imports a trimmed Monaco runtime, selected language contributions, and Vite worker entry points. This matches Monaco's official Vite guidance: implement `self.MonacoEnvironment.getWorker` and use `?worker` imports.
- `src/components/CodeEditor.tsx` still renders `<Editor />` from `@monaco-editor/react` and relies on wrapper props:
  - `path`
  - `language`
  - `theme`
  - `defaultValue`
  - `value`
  - `saveViewState`
  - `beforeMount`
  - `onMount`
  - `options`
- `src/components/editorConstants.ts` and `src/components/editorModels.ts` import the wrapper's `Monaco` type.
- `src/components/preview/ApiClientPanel.tsx` also imports `Editor` from `@monaco-editor/react`, so removing the dependency fully requires migrating those two small embedded editors too.
- There is not yet a wrapper-free local Monaco package that can be reused by `CodeEditor`, `ApiClientPanel`, and future Monaco-backed surfaces.

## Migration Strategy

### 1. Create the local Monaco package

Create a reusable local package under `src/monaco/` with a public `index.ts`. This is an internal project package, not a published npm package.

File layout:

```txt
src/monaco/
  index.ts
  runtime.ts
  MonacoEditor.tsx
  useOwnedModel.ts
  models.ts
  theme.ts
  typescriptDefaults.ts
```

Package responsibilities:

- `runtime.ts`: self-hosted Monaco runtime, language contributions, worker setup, `monaco` export, `Monaco` type export, and the **one-time, idempotency-guarded** init that registers the theme and TypeScript defaults.
- `MonacoEditor.tsx`: reusable React primitive that attaches a caller-supplied model to `monaco.editor.create`, owns layout observation via `ResizeObserver`, enforces `automaticLayout: false` unconditionally, reconciles options, and exposes lifecycle callbacks. It never creates or disposes a model — model lifecycle always belongs to the caller.
- `useOwnedModel.ts`: a small hook that creates a Monaco model from a `uri`/`value`/`language` triple, keeps its content and language in sync, and disposes it on unmount or URI change. Used by simple embedded editors that don't need custom model-ownership policy (e.g. `ApiClientPanel`).
- `models.ts`: workspace/playback URI helpers, `syncWorkspaceModel`, `syncPlaybackModel`, playback disposal, and view-state helpers.
- `theme.ts`: `defineNextEditorTheme`, `setActiveTheme` (the _only_ call site allowed to invoke `monaco.editor.setTheme`), shared editor options, and API-panel-safe theme constants.
- `typescriptDefaults.ts`: TypeScript/JavaScript defaults and extra libs configuration.
- `index.ts`: the only import surface other app code should use. Importing it triggers `runtime.ts`'s one-time init as a side effect.

This package should replace direct app imports from `src/components/monacoSetup.ts`, `src/components/editorConstants.ts`, and `src/components/editorModels.ts`. Keep temporary re-exports only if needed to land the migration in smaller commits.

Suggested public exports:

```ts
export { monaco, type Monaco } from "./runtime";
export { MonacoEditor, type MonacoEditorProps } from "./MonacoEditor";
export { useOwnedModel } from "./useOwnedModel";
export {
  NEXT_EDITOR_MONACO_THEME,
  defineNextEditorTheme,
  setActiveTheme,
  getEditorOptions,
} from "./theme";
export {
  configureMonacoTypeScript,
  getMonacoCompilerOptions,
  MONACO_EXTRA_LIBS,
} from "./typescriptDefaults";
export {
  disposePlaybackModels,
  syncPlaybackModel,
  syncWorkspaceModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  workspacePathFromMonacoModelUri,
} from "./models";
```

### 2. Move `monacoSetup.ts` into the package runtime, with a single idempotent init

Move `src/components/monacoSetup.ts` to `src/monaco/runtime.ts`. Keep the existing language and worker imports. Remove the wrapper loader import and `loader.config({ monaco })`.

Change:

```ts
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// ...
loader.config({ monaco });
```

To:

```ts
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { defineNextEditorTheme } from "./theme";
import { configureMonacoTypeScript } from "./typescriptDefaults";

// Guard on a global flag, not a module-level variable, so this stays
// idempotent across React StrictMode remounts *and* Vite HMR module reloads.
const globalScope = self as typeof self & {
  __nextEditorMonacoRuntimeInitialized?: boolean;
};

function ensureMonacoRuntimeInitialized() {
  if (globalScope.__nextEditorMonacoRuntimeInitialized) return;
  globalScope.__nextEditorMonacoRuntimeInitialized = true;

  self.MonacoEnvironment = monacoEnvironment;
  defineNextEditorTheme(monaco);
  configureMonacoTypeScript();
}

ensureMonacoRuntimeInitialized();

export { monaco };
export type Monaco = typeof monaco;
```

`runtime.ts` (via `index.ts`) is the **only** place that calls `defineNextEditorTheme` and `configureMonacoTypeScript`. `CodeEditor.tsx`'s mount effect must not call them again — see Section 5. This is what actually prevents the one-frame flash of Monaco's default theme, and it also sidesteps a real Monaco footgun: `addExtraLib` and theme registration are not safe to call repeatedly with the same identifier — depending on version, a second call either throws or silently duplicates the entry.

The worker setup must be synchronous and available before the first `monaco.editor.create` call. Make `runtime.ts` the first thing loaded by the package import path, and make `MonacoEditor.tsx` import `monaco` from `./runtime` rather than importing `monaco-editor` directly.

Update comments so they describe direct Monaco initialization, not pointing `@monaco-editor/react` at a bundled instance. All consumers should import from `src/monaco`, for example:

```ts
import { monaco, type Monaco } from "../monaco";
```

### 3. Replace wrapper types

Move or update `src/components/editorConstants.ts`, `src/components/editorModels.ts`, and their tests to stop importing `Monaco` from `@monaco-editor/react`.

Preferred local type:

```ts
import type { Monaco } from "../monaco";
```

For editor instances in `CodeEditor.tsx`, use:

```ts
type StandaloneEditor = monaco.editor.IStandaloneCodeEditor;
```

This keeps type/value imports aligned with the actual runtime module.

### 4. Build the reusable `MonacoEditor` primitive

Create `src/monaco/MonacoEditor.tsx` before migrating either app surface. This component owns the raw `monaco.editor.create` call, the editor DOM lifecycle, and layout — but **not** model lifecycle and **not** theme.

Reusable API:

```ts
interface MonacoEditorProps {
  className?: string;
  model: monaco.editor.ITextModel;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  onChange?: (value: string, editor: monaco.editor.IStandaloneCodeEditor) => void;
  onMount?: (editor: monaco.editor.IStandaloneCodeEditor, monaco: Monaco) => void | (() => void);
  onBeforeModelChange?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    currentModel: monaco.editor.ITextModel | null,
  ) => void;
  onAfterModelChange?: (
    editor: monaco.editor.IStandaloneCodeEditor,
    nextModel: monaco.editor.ITextModel | null,
  ) => void;
}
```

Compared to a naive port of the wrapper's props, this intentionally drops:

- `theme` — global concept, not per-instance; see Section 5 and `setActiveTheme`.
- `modelUri` / `value` / `language` — model _creation_ is never this component's job; see `useOwnedModel` (Section 11) and `models.ts` (Section 6).
- `preserveViewState` — dead in the original sketch; view state is handled entirely via `onBeforeModelChange`/`onAfterModelChange` in `CodeEditor.tsx` (Section 7).

Ownership rules:

- The caller always supplies a fully-formed `model`. `MonacoEditor` attaches it and, on later renders, re-attaches whichever model it's currently given — but **never creates or disposes a model**, full stop. There is only one code path here, not an owned-vs-parent-owned branch.
- Update language, content sync, and model creation all live in the caller (either `models.ts` helpers or `useOwnedModel`).
- Keep `automaticLayout: false` at creation and on **every** `updateOptions` call, regardless of what the `options` prop contains — spread `options` first, then set `automaticLayout: false` last, e.g. `{ ...options, automaticLayout: false }`, so a caller cannot accidentally re-enable it. The component owns a `ResizeObserver` and calls `editor.layout()` itself; do not rely on Monaco's built-in automatic layout and a custom `ResizeObserver` at the same time.
- Call `onBeforeModelChange` before `editor.setModel(nextModel)` and `onAfterModelChange` afterward, exactly once per model-reference change.
- Dispose callback disposables, the `ResizeObserver`, and the editor instance on unmount. Never call `.dispose()` on a model — it isn't this component's to dispose.

Lifecycle algorithm:

1. Create the editor once after the container ref is available, using the initial `model` prop and `{ ...options, model, automaticLayout: false }`. Do not pass `theme` here — the editor picks up whatever theme is currently globally active.
2. Register `onDidChangeModelContent` for `onChange` **once**, at creation. This is an editor-level event that automatically tracks whichever model is currently attached, so it does not need to be re-registered on `setModel`.
3. Register a `ResizeObserver`, call `editor.layout()` on resize, and call `editor.layout()` once after creation.
4. On `model` prop reference change: call `onBeforeModelChange(editor, currentModel)`, then `editor.setModel(nextModel)`, then `onAfterModelChange(editor, nextModel)`.
5. On `options` prop change: call `editor.updateOptions({ ...options, automaticLayout: false })`.
6. On cleanup, make disposal idempotent — disconnect the `ResizeObserver`, dispose listener disposables, dispose the editor — so React StrictMode remounts and rapid panel toggles do not double-dispose resources. Do not touch the model.

Because this component no longer owns model lifecycle, its own unit tests shrink to: editor/observer/listener creation and idempotent disposal, `setModel` callback ordering, and `automaticLayout` enforcement. Model-lifecycle tests move to `models.ts` and `useOwnedModel.ts` respectively (see the Verification Checklist).

### 5. Use the package primitive in `CodeEditor.tsx`

Replace the `<Editor />` render with the shared package component:

```tsx
<MonacoEditor
  className="h-full w-full"
  model={activeModel}
  options={{ ...getEditorOptions(isPlaying), automaticLayout: false }}
  onMount={handleEditorDidMount}
  onBeforeModelChange={saveCurrentNormalViewState}
  onAfterModelChange={restoreNextNormalViewState}
/>
```

`theme` is deliberately not passed as a prop. Instead, `CodeEditor.tsx` calls the package's global theme setter whenever its own `theme` value changes:

```ts
useEffect(() => {
  setActiveTheme(theme);
}, [theme]);
```

`CodeEditor.tsx` is the **only** call site that ever calls `setActiveTheme`. `ApiClientPanel` must not call it — see Section 11.

Keep `CodeEditor`-specific refs and orchestration in `CodeEditor.tsx`:

```ts
const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
const isApplyingExternalModelValueRef = useRef(false);
```

Confirm during implementation whether `isApplyingExternalModelValueRef` already exists in the current wrapper-based code. If it does, carry it over and wire it into `syncWorkspaceModel` from day one (Section 6) rather than deferring it — an existing ref is presumably already guarding a real race, not a hypothetical future one.

Runtime and theme initialization is no longer redone here. Before the first `MonacoEditor` render, `CodeEditor.tsx`'s mount effect should only do genuinely per-mount / per-transition work:

```ts
monacoRef.current = monaco;
syncActivePlaybackModel(monaco);
```

`configureMonacoTypeScript()` and `defineNextEditorTheme(monaco)` are **not** called here — they already ran exactly once inside `runtime.ts` (Section 2).

`CodeEditor.tsx` should own workspace/playback model selection, view-state policy, recording/replay listener wiring, save shortcut integration, binary preview switching, theme activation, and shared machine refs. The reusable package should own only the generic editor lifecycle and direct Monaco details.

Render `MonacoEditor` only when `!isBinaryActiveFile`. Unlike the React wrapper, direct Monaco will not manage app-level refs, so the binary-file branch must run `CodeEditor` cleanup that clears `editorRef.current` and `syncEditorRef(null)`.

### 6. Recreate the wrapper's model behavior explicitly

Add a package helper in `src/monaco/models.ts` for normal workspace models:

```ts
function syncWorkspaceModel(
  monaco: Monaco,
  workspacePath: string,
  content: string,
  language: string,
) {
  const uri = monaco.Uri.parse(toMonacoModelPath(workspacePath));
  const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, language, uri);

  if (model.getLanguageId() !== language) {
    monaco.editor.setModelLanguage(model, language);
  }

  if (model.getValue() !== content) {
    model.setValue(content);
  }

  return model;
}
```

Use existing `syncPlaybackModel` for playback mode. Keep `preserveExistingContent: true` for playback to avoid clobbering replay-owned model content.

Treat `model.setValue` as an external reconciliation path only. Local edits already flow through `onDidChangeModelContent -> updateFileContent`; when that store update re-renders `CodeEditor`, the model value should normally already match and avoid a second `setValue`. If local edits ever race with external value sync, use `isApplyingExternalModelValueRef` to suppress duplicate recording/workspace updates from a programmatic `setValue` call.

Important parity with wrapper props:

- `path`: represented by the model URI from `toMonacoModelPath` or `toPlaybackModelPath`.
- `language`: set via `createModel(..., language, uri)` and `monaco.editor.setModelLanguage`.
- `value`: synced into the normal workspace model when external workspace content changes.
- `defaultValue`: only relevant to playback model creation; keep the existing `activeFile.content` creation path.
- `saveViewState={!usesPlaybackModel}`: store/restore `editor.saveViewState()` by model URI only for normal workspace models — implemented entirely through `CodeEditor`'s `onBeforeModelChange`/`onAfterModelChange` callbacks (Section 7), not a `MonacoEditor` prop.
- `theme`: `CodeEditor` calls `setActiveTheme(theme)` when the prop changes (Section 5).
- `options`: call `editor.updateOptions({ ...getEditorOptions(isPlaying), automaticLayout: false })` when playback state changes. Note `getEditorOptions` currently returns `automaticLayout: true`; `MonacoEditor` overrides this internally regardless (Section 4), so this is now belt-and-suspenders rather than load-bearing.

### 7. Preserve view state during file switches

Before `editor.setModel(nextModel)`, save the current normal model state:

```ts
const currentModel = editor.getModel();
if (currentModel && !currentModel.uri.toString().startsWith("file:///__next-editor__/playback/")) {
  viewStatesRef.current.set(currentModel.uri.toString(), editor.saveViewState());
}
```

After switching to a normal model:

```ts
const nextViewState = viewStatesRef.current.get(nextModel.uri.toString());
if (nextViewState) {
  editor.restoreViewState(nextViewState);
}
```

Do not restore view state for playback models. Playback owns cursor/scroll rendering and the current wrapper intentionally disables `saveViewState` while `usesPlaybackModel` is true.

Also save the current normal model view state before final unmount and before the editor is disposed for a binary-file transition. This preserves the wrapper's `saveViewState` behavior across text → binary → text navigation.

### 8. Preserve event wiring

Keep the existing `handleEditorDidMount` listener setup almost unchanged, but type it against `IStandaloneCodeEditor` instead of `OnMount`.

Listeners to preserve:

- `onDidChangeModel`
- `onDidChangeModelContent`
- `onDidChangeCursorPosition`
- `onDidChangeCursorSelection`
- `onDidScrollChange`

Keep the current guards:

- `syncEditorContentToWorkspace` must skip playback and binary files.
- `onEditorChange` must skip playback.
- `disposePlaybackModelsIfIdle` must preserve the active model URI.
- Binary files must clear `editorRef.current` and `syncEditorRef(null)`.

When programmatic model/content sync is in progress, ensure the content listener does not produce duplicate workspace writes or capture frames. The current playback guards are still required because replay applies frames by setting the active playback model content directly.

### 9. Add direct layout handling

The wrapper handled container layout for us. The package `MonacoEditor` adds a `ResizeObserver` on its editor container and calls `editor.layout()` on resize, plus once immediately after creation. Because `automaticLayout: false` is enforced _inside_ the component (Section 4) rather than by convention at call sites, this holds automatically anywhere the component is used — including the flex layout with `FileSidebar`, `Preview`, and `TerminalPanel`, and the smaller request/response editors in `ApiClientPanel` — without each caller needing to remember the override.

### 10. Dispose correctly

`MonacoEditor` disposes generic Monaco editor resources only; it never touches models. `CodeEditor.tsx` disposes app-level integrations and the models it owns. `useOwnedModel` disposes the models it created for simple embedded editors.

`MonacoEditor` cleanup should:

- Dispose its internal listener disposables.
- Call `resizeObserver.disconnect()` and clear the observer ref.
- Call its editor's `dispose()`.
- Clear its local editor and observer refs after disposal.

`CodeEditor.tsx` cleanup should run on true unmount and text-editor removal when a binary asset is selected. It should:

- Dispose recording/replay listener disposables.
- Save current normal view state.
- Dispose playback models via `disposePlaybackModels(monaco)`.
- Clear `editorRef.current` and `syncEditorRef(null)`.

Do not eagerly dispose normal workspace models on every file switch, because they are the replacement for the wrapper's `path` and `saveViewState` behavior. Consider disposing all normal workspace models only when the full `CodeEditor` unmounts if memory becomes an issue.

### 11. Use the package primitive in `ApiClientPanel`

To fully remove `@monaco-editor/react`, migrate the two embedded editors in `src/components/preview/ApiClientPanel.tsx`:

- request body editor at lines around `172`
- response body read-only editor at lines around `402`

Use `src/monaco/MonacoEditor.tsx` together with `useOwnedModel` here. `ApiClientPanel` should not create a separate one-off Monaco integration, and should not call `setActiveTheme` — it inherits whatever theme `CodeEditor` last activated globally, which resolves the theme-scope race by construction rather than by patching it after the fact.

Request body editor:

```tsx
const requestModel = useOwnedModel({
  uri: "file:///__next-editor__/api-client/request-body.json",
  value: body,
  language: "json",
});

<MonacoEditor
  className="..."
  model={requestModel}
  options={compactBodyOptions}
  onChange={(value) => store.trigger.setBody({ body: value })}
/>;
```

Response body editor:

- Use a `uri` derived from the response/history entry id when possible, or a fixed URI if only the current response is shown.
- Pass `value={prettyBody}`, `language={lang}` into `useOwnedModel`, and read-only options into `MonacoEditor`.
- `useOwnedModel` disposes the previous owned model automatically when the URI changes or the component unmounts — `ApiClientPanel` does not need its own disposal logic.

Ownership rules for the simple API-panel component:

- Import `MonacoEditor`, `useOwnedModel`, and other package helpers from `src/monaco` so the same worker setup and runtime init are used.
- `useOwnedModel` syncs `value` only when it differs from `model.getValue()`, and updates language via `monaco.editor.setModelLanguage` when it changes.
- Never reach for `models.ts`'s workspace/playback helpers here — those are `CodeEditor`'s models, not the API panel's.
- Rely on `MonacoEditor`'s own `ResizeObserver`; do not add a second one.

### 12. Remove the wrapper dependency

After all imports are gone:

```sh
bun remove @monaco-editor/react
```

Confirm these return no wrapper references:

```sh
rg "@monaco-editor/react|loader\\.config|from \"@monaco-editor/react\"" src package.json bun.lock
```

## Suggested Implementation Order

1. Create `src/monaco/` with `runtime.ts` (one-time, HMR-safe init), `MonacoEditor.tsx` (model-agnostic, no theme prop, `automaticLayout` enforced internally), `useOwnedModel.ts`, `models.ts`, `theme.ts` (with `setActiveTheme`), `typescriptDefaults.ts`, and `index.ts`.
2. Move `monacoSetup.ts`, editor constants, and editor model helpers behind the new package import surface. Confirm whether `isApplyingExternalModelValueRef` already exists in the current implementation and carry it over if so.
3. Decide the test environment for Monaco-backed component tests (real browser via Playwright component testing, or Vitest browser mode — plain jsdom does not support `editor.create`, workers, or layout measurement well). Settle this before step 6, not during it.
4. Update existing tests/imports to use the package `Monaco` type and model helpers.
5. Convert `CodeEditor.tsx` from `<Editor />` to the package `MonacoEditor`, preserving existing model selection, handlers, and machine refs, and replacing the `theme` prop with `setActiveTheme` calls.
6. Add focused tests for workspace/playback model helpers, view-state exclusion rules, and `MonacoEditor`'s editor-only lifecycle (creation, idempotent disposal, `setModel` callback ordering, `automaticLayout` enforcement).
7. Verify file switching, typing, save shortcut, playback, recording, binary preview, and terminal/preview layout.
8. Convert `ApiClientPanel.tsx` to the package `MonacoEditor` + `useOwnedModel`.
9. Remove `@monaco-editor/react` from dependencies and update `bun.lock`.
10. Run automated checks and a browser smoke test.

## Verification Checklist

Run:

```sh
bun run typecheck
bun run test
bun run build
```

Manual smoke test:

- Open a text file and confirm syntax highlighting for TS/JS/JSON/CSS/HTML/Markdown.
- Edit a file and confirm workspace content updates.
- Switch between files and confirm cursor/scroll view state is restored for normal editing.
- Switch from a text file to a binary asset and back, then confirm the text editor is recreated, the shared editor ref is live again, and the previous view state is restored.
- Start playback and confirm the playback model attaches, cursor/scroll replay works, and editor edits do not mutate workspace content.
- Stop playback and confirm playback models are disposed except the active preserved model during transition.
- Open a binary asset and confirm the editor ref is cleared and `BinaryFilePreview` renders.
- Use `Cmd+S`/`Ctrl+S` and confirm the same save behavior.
- Resize the sidebar/preview/terminal and confirm Monaco lays out correctly.
- Open the API client request/response editors and confirm editing/read-only behavior works after wrapper removal, and that opening them does not change the main editor's theme.

Targeted automated tests to add or update:

`MonacoEditor` (editor-only, no model ownership):

- Creates the editor once and disposes it, its listener disposables, and its `ResizeObserver` idempotently — including under a StrictMode double-invoke.
- Calls `onBeforeModelChange`/`onAfterModelChange` around `editor.setModel` exactly once per model-reference change.
- Never calls `.dispose()` on any `monaco.editor.ITextModel` it's given, including on its own unmount.
- Forces `automaticLayout: false` at creation and on every `updateOptions` call regardless of what the `options` prop contains, while still calling `layout()` via its `ResizeObserver`.

`useOwnedModel`:

- Creates a model from `uri`/`value`/`language` and disposes it on unmount or URI change.
- Only calls `setValue` when content differs from `model.getValue()`.
- Updates language via `monaco.editor.setModelLanguage` when it changes.

`models.ts`:

- `syncWorkspaceModel` creates a workspace model with the expected URI.
- `syncWorkspaceModel` reuses an existing model and updates its language.
- `syncWorkspaceModel` only calls `setValue` when content differs.
- Workspace URI helpers continue to reject playback URIs as writable paths.
- Playback disposal still preserves normal workspace models.
- View-state helpers save/restore only normal workspace model URIs, not playback model URIs.

`theme.ts`:

- `setActiveTheme` is the only function in the codebase that calls `monaco.editor.setTheme`.
- `ApiClientPanel`'s editors never call `setActiveTheme`, directly or indirectly.

## Main Risks

- **View-state parity**: `@monaco-editor/react` managed `saveViewState`; direct Monaco needs explicit save/restore keyed by model URI.
- **Controlled value parity**: direct `model.setValue` can reset undo history. Only call it when the workspace content differs from the model and avoid calling it in response to the same local edit.
- **Playback model ownership**: playback currently relies on model swapping and content preservation. Keep the current `syncPlaybackModel(..., { preserveExistingContent: true })` flow.
- **Binary-file transitions**: React will remove the editor container, but direct Monaco must still be explicitly disposed and detached from the shared machine refs.
- **Layout**: direct Monaco needs explicit layout handling in this flex-heavy UI. Mitigated by enforcing `automaticLayout: false` inside `MonacoEditor` itself rather than relying on every call site to set it correctly.
- **Theme scope**: `monaco.editor.setTheme` is global. Mitigated by construction — `theme` is not a `MonacoEditor` prop at all, and only `CodeEditor` ever calls `setActiveTheme`.
- **Initialization order**: the package runtime must set `self.MonacoEnvironment.getWorker` and register the app theme synchronously before any `MonacoEditor` creates an editor. Mitigated by a single, globally-flagged init in `runtime.ts` (Section 2) rather than assuming module-load order works out.
- **HMR re-initialization**: a plain module-level boolean guard resets when Vite HMR replaces the module. Use a flag on `self` (or another object that survives module reload) so `ensureMonacoRuntimeInitialized` stays idempotent across HMR, not just across StrictMode remounts.
- **StrictMode/remount behavior**: cleanup must be idempotent, including `ResizeObserver.disconnect()`, editor disposal, and callback disposal. Model disposal is no longer `MonacoEditor`'s concern at all, which removes one whole category of double-disposal bug.
- **Hidden remaining dependency**: `ApiClientPanel.tsx` must be migrated before `@monaco-editor/react` can be removed from `package.json`.
- **Test environment**: Monaco needs a real browser-like environment (workers, layout) to exercise `editor.create` meaningfully — decide this early (implementation order step 3) rather than discovering jsdom limitations while writing `MonacoEditor`'s tests.
