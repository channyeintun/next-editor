# Migration Plan: Create a Reusable Monaco Package and Replace `@monaco-editor/react`

## Goal

Create a reusable local Monaco package for this project, then move all editor surfaces from the inactive React wrapper to that shared package. The migration must preserve the current self-hosted Vite worker setup, custom theme, TypeScript defaults, multi-file models, playback models, save behavior, and recording/replay event hooks.

Primary upstream references:

- Monaco ESM integration guide: https://github.com/microsoft/monaco-editor/blob/main/docs/integrate-esm.md
- Monaco Vite React sample worker setup: https://github.com/microsoft/monaco-editor/blob/main/samples/browser-esm-vite-react/src/userWorker.ts
- Monaco `editor.create` API: https://microsoft.github.io/monaco-editor/typedoc/functions/editor_editor_api.editor.create.html
- `monaco-editor` home/API site, currently showing the latest released editor package as `0.55.1`: https://microsoft.github.io/monaco-editor/
- `@monaco-editor/react` npm page, currently showing the separate React wrapper package as latest `4.7.0`, last published about a year ago: https://www.npmjs.com/package/%40monaco-editor/react

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

Proposed file layout:

```txt
src/monaco/
  index.ts
  runtime.ts
  MonacoEditor.tsx
  models.ts
  theme.ts
  typescriptDefaults.ts
```

Package responsibilities:

- `runtime.ts`: self-hosted Monaco runtime, language contributions, worker setup, `monaco` export, and `Monaco` type export.
- `MonacoEditor.tsx`: reusable React primitive that creates/disposes `monaco.editor.create`, owns layout observation, updates options/theme/model, and exposes lifecycle callbacks.
- `models.ts`: workspace/playback URI helpers, `syncWorkspaceModel`, `syncPlaybackModel`, playback disposal, model ownership helpers, and view-state helpers.
- `theme.ts`: `defineNextEditorTheme`, shared editor options, and API-panel-safe theme constants.
- `typescriptDefaults.ts`: TypeScript/JavaScript defaults and extra libs configuration.
- `index.ts`: the only import surface other app code should use.

This package should replace direct app imports from `src/components/monacoSetup.ts`, `src/components/editorConstants.ts`, and `src/components/editorModels.ts`. Keep temporary re-exports only if needed to land the migration in smaller commits.

Suggested public exports:

```ts
export { monaco, type Monaco } from "./runtime";
export { MonacoEditor, type MonacoEditorProps } from "./MonacoEditor";
export { NEXT_EDITOR_MONACO_THEME, defineNextEditorTheme, getEditorOptions } from "./theme";
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

### 2. Move `monacoSetup.ts` into the package runtime

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
// ...
self.MonacoEnvironment = monacoEnvironment;

export { monaco };
export type Monaco = typeof monaco;
```

Update comments so they describe direct Monaco initialization, not pointing `@monaco-editor/react` at a bundled instance. All consumers should import from `src/monaco`, for example:

```ts
import { monaco, type Monaco } from "../monaco";
```

The worker setup must be synchronous and available before the first `monaco.editor.create` call. Make `runtime.ts` the first thing loaded by the package import path, and make `MonacoEditor.tsx` import `monaco` from `./runtime` rather than importing `monaco-editor` directly.

Define the app theme before any editor can mount. Prefer having `runtime.ts` call an internal theme initializer immediately after setting `self.MonacoEnvironment`, or have `index.ts` perform the runtime/theme initialization as a module-load side effect. This avoids a one-frame flash of Monaco's default theme before `next-editor-dark` is registered and selected.

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

Create `src/monaco/MonacoEditor.tsx` before migrating either app surface. This component should be the only place that owns the raw `monaco.editor.create` and editor DOM lifecycle.

Minimal reusable API:

```ts
interface MonacoEditorProps {
  className?: string;
  model?: monaco.editor.ITextModel | null;
  modelUri?: string;
  value?: string;
  language?: string;
  theme?: string;
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
  preserveViewState?: boolean;
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

Ownership rules:

- If `model` is provided, the parent owns that model. The component must attach it but must not dispose it.
- If `modelUri`/`value`/`language` are provided without `model`, the component may create an owned model and must dispose that owned model on unmount or URI change.
- Sync `value` only when it differs from `model.getValue()`.
- Update language with `monaco.editor.setModelLanguage`.
- Keep `automaticLayout: false`; the component owns a `ResizeObserver` and calls `editor.layout()`.
- Call `onBeforeModelChange` before `editor.setModel(nextModel)` and `onAfterModelChange` afterward.
- Dispose callback disposables, the `ResizeObserver`, the editor instance, and owned models on unmount.
- Apply `theme` deliberately. Monaco themes are global, so prefer package-level theme constants and avoid letting a small embedded editor permanently switch the main editor theme.

Lifecycle algorithm:

1. Create the editor once after the container ref is available.
2. Resolve the active model from either parent-owned `model` or owned `modelUri`/`value`/`language`.
3. Create with `{ ...options, model, theme, automaticLayout: false }`.
4. Register `onDidChangeModelContent` for `onChange`.
5. Register a `ResizeObserver`, call `editor.layout()` on resize, and call `editor.layout()` once after creation.
6. On prop updates, reconcile model, value, language, options, and theme without recreating the editor.
7. Before model switches, call `onBeforeModelChange`; after `editor.setModel`, call `onAfterModelChange`.
8. On cleanup, make disposal idempotent so React StrictMode remounts and rapid panel toggles do not double-dispose editor/model resources.

### 5. Use the package primitive in `CodeEditor.tsx`

Replace the `<Editor />` render with the shared package component:

```tsx
<MonacoEditor
  className="h-full w-full"
  model={activeModel}
  theme={theme}
  options={{ ...getEditorOptions(isPlaying), automaticLayout: false }}
  onMount={handleEditorDidMount}
  onBeforeModelChange={saveCurrentNormalViewState}
  onAfterModelChange={restoreNextNormalViewState}
/>
```

Keep CodeEditor-specific refs and orchestration in `CodeEditor.tsx`:

```ts
const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
const isApplyingExternalModelValueRef = useRef(false);
```

Before the first `MonacoEditor` render, run the old `beforeMount` work through the package:

```ts
monacoRef.current = monaco;
configureMonacoTypeScript();
syncActivePlaybackModel(monaco);
defineNextEditorTheme(monaco);
```

`CodeEditor.tsx` should own workspace/playback model selection, view-state policy, recording/replay listener wiring, save shortcut integration, binary preview switching, and shared machine refs. The reusable package should own only the generic editor lifecycle and direct Monaco details.

Render `MonacoEditor` only when `!isBinaryActiveFile`. Unlike the React wrapper, direct Monaco will not manage app-level refs, so the binary-file branch must run CodeEditor cleanup that clears `editorRef.current` and `syncEditorRef(null)`.

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

Treat `model.setValue` as an external reconciliation path only. Local edits already flow through `onDidChangeModelContent -> updateFileContent`; when that store update re-renders the editor, the model value should normally match and avoid a second `setValue`. If a future refactor makes local edits race with external value sync, add a small suppression flag such as `isApplyingExternalModelValueRef` so programmatic `setValue` calls do not produce duplicate recording/workspace updates.

Important parity with wrapper props:

- `path`: represented by the model URI from `toMonacoModelPath` or `toPlaybackModelPath`.
- `language`: set via `createModel(..., language, uri)` and `monaco.editor.setModelLanguage`.
- `value`: synced into the normal workspace model when external workspace content changes.
- `defaultValue`: only relevant to playback model creation; keep the existing `activeFile.content` creation path.
- `saveViewState={!usesPlaybackModel}`: store/restore `editor.saveViewState()` by model URI only for normal workspace models.
- `theme`: call `monaco.editor.setTheme(theme)` when the prop changes.
- `options`: call `editor.updateOptions({ ...getEditorOptions(isPlaying), automaticLayout: false })` when playback state changes, because `getEditorOptions` currently includes `automaticLayout: true`.

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

Also save the current normal model view state before final unmount and before the editor is disposed for a binary-file transition. This preserves the wrapper's `saveViewState` behavior across text -> binary -> text navigation.

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

The wrapper handled container layout for us. The package `MonacoEditor` should add a `ResizeObserver` on its editor container and call:

```ts
editor.layout();
```

Also call `editor.layout()` immediately after creation. This should preserve behavior anywhere the package component is used, including the flex layout with `FileSidebar`, `Preview`, and `TerminalPanel`, plus the smaller request/response editors in `ApiClientPanel`.

Keep `automaticLayout: false` at creation and on every `updateOptions` call. Do not rely on Monaco's built-in automatic layout and a custom `ResizeObserver` at the same time.

### 10. Dispose correctly

The package component should dispose generic Monaco resources, while `CodeEditor.tsx` should dispose app-level integrations.

`MonacoEditor` cleanup should:

- Dispose its internal listener disposables.
- Call `resizeObserver.disconnect()` and clear the observer ref.
- Call its owned editor's `dispose()`.
- Dispose only models that the component created itself.
- Clear its local editor and observer refs after disposal.

`CodeEditor.tsx` cleanup should run on true unmount and text-editor removal when a binary asset is selected. It should:

- Dispose recording/replay listener disposables.
- Save current normal view state.
- Dispose playback models via `disposePlaybackModels(monaco)`.
- Clear `editorRef.current` and `syncEditorRef(null)`.

Do not eagerly dispose normal workspace models on every file switch, because they are the replacement for the wrapper's `path` and `saveViewState` behavior. Consider disposing all normal workspace models only when the full CodeEditor unmounts if memory becomes an issue.

### 11. Use the package primitive in `ApiClientPanel`

To fully remove `@monaco-editor/react`, migrate the two embedded editors in `src/components/preview/ApiClientPanel.tsx`:

- request body editor at lines around `172`
- response body read-only editor at lines around `402`

Use `src/monaco/MonacoEditor.tsx` here too. `ApiClientPanel` should not create a separate one-off Monaco integration.

Request body editor:

- Use a stable `modelUri` such as `file:///__next-editor__/api-client/request-body.json`.
- Pass `value={body}`, `language="json"`, and `onChange={(value) => store.trigger.setBody({ body: value })}`.
- Keep the existing compact body options.

Response body editor:

- Use a stable `modelUri` derived from the response/history entry id when possible, or a fixed URI if only the current response is shown.
- Pass `value={prettyBody}`, `language={lang}`, and read-only options.
- The package component should dispose owned response models when the response editor unmounts or switches URI.

Ownership rules for the simple API-panel component:

- Import `MonacoEditor` and package helpers from `src/monaco` so the same worker setup is used.
- Let the package component create owned models from `modelUri`/`value`/`language`.
- Dispose only models that the package component created; never dispose the main workspace or playback models.
- Sync `value` only when it differs from `model.getValue()`.
- Update language with `monaco.editor.setModelLanguage`.
- Handle `onChange` from `onDidChangeModelContent`.
- Rely on the package component's `ResizeObserver`.
- Be careful with `theme`: Monaco themes are global. If the API panel uses `vs-dark`, it may affect the main editor while both are mounted. Prefer using the same `next-editor-dark` theme or immediately reapply the main editor theme from `CodeEditor` when its `theme` prop changes.

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

1. Create `src/monaco/` with `runtime.ts`, `MonacoEditor.tsx`, model helpers, theme/options, TypeScript defaults, and `index.ts`.
2. Move `monacoSetup.ts`, editor constants, and editor model helpers behind the new package import surface.
3. Update existing tests/imports to use the package `Monaco` type and model helpers.
4. Convert `CodeEditor.tsx` from `<Editor />` to the package `MonacoEditor`, preserving existing model selection, handlers, and machine refs.
5. Add focused tests for workspace/playback model helpers and view-state exclusion rules.
6. Verify file switching, typing, save shortcut, playback, recording, binary preview, and terminal/preview layout.
7. Convert `ApiClientPanel.tsx` to the package `MonacoEditor`.
8. Remove `@monaco-editor/react` from dependencies and update `bun.lock`.
9. Run automated checks and a browser smoke test.

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
- Open the API client request/response editors and confirm editing/read-only behavior works after wrapper removal.

Targeted automated tests to add or update:

- `MonacoEditor` creates and disposes owned models created from `modelUri`/`value`/`language`.
- `MonacoEditor` does not dispose a parent-owned `model` passed by `CodeEditor`.
- `MonacoEditor` calls model-change callbacks around `editor.setModel`.
- `MonacoEditor` keeps `automaticLayout: false` while still calling `layout()` through its `ResizeObserver`.
- `syncWorkspaceModel` creates a workspace model with the expected URI.
- `syncWorkspaceModel` reuses an existing model and updates its language.
- `syncWorkspaceModel` only calls `setValue` when content differs.
- Workspace URI helpers continue to reject playback URIs as writable paths.
- Playback disposal still preserves normal workspace models.
- View-state helpers save/restore only normal workspace model URIs, not playback model URIs.

## Main Risks

- View-state parity: `@monaco-editor/react` managed `saveViewState`; direct Monaco needs explicit save/restore keyed by model URI.
- Controlled value parity: direct `model.setValue` can reset undo history. Only call it when the workspace content differs from the model and avoid calling it in response to the same local edit.
- Playback model ownership: playback currently relies on model swapping and content preservation. Keep the current `syncPlaybackModel(..., { preserveExistingContent: true })` flow.
- Binary-file transitions: React will remove the editor container, but direct Monaco must still be explicitly disposed and detached from the shared machine refs.
- Layout: direct Monaco needs explicit layout handling in this flex-heavy UI, with `automaticLayout` kept consistently disabled if using a custom `ResizeObserver`.
- Theme scope: `monaco.editor.setTheme` is global, so API-panel editors can unintentionally change the main editor's theme.
- Initialization order: the package runtime must set `self.MonacoEnvironment.getWorker` and register the app theme synchronously before any `MonacoEditor` creates an editor.
- StrictMode/remount behavior: cleanup must be idempotent, including `ResizeObserver.disconnect()`, editor disposal, callback disposal, and owned-model disposal.
- Hidden remaining dependency: `ApiClientPanel.tsx` must be migrated before `@monaco-editor/react` can be removed from `package.json`.
