export { monaco, type Monaco } from "./runtime";
export { MonacoEditor, type MonacoEditorProps } from "./MonacoEditor";
export { useOwnedModel } from "./useOwnedModel";
export {
  NEXT_EDITOR_MONACO_THEME,
  defineNextEditorTheme,
  getEditorOptions,
  setActiveTheme,
} from "./theme";
export {
  MONACO_EXTRA_LIBS,
  configureMonacoTypeScript,
  getMonacoCompilerOptions,
} from "./typescriptDefaults";
export {
  acknowledgeWorkspaceModelContent,
  disposePlaybackModels,
  isPlaybackModelUri,
  syncPlaybackModel,
  syncWorkspaceModel,
  toMonacoModelPath,
  toPlaybackModelPath,
  workspacePathFromMonacoModelUri,
} from "./models";
