import type { Monaco } from "@monaco-editor/react";
import * as monacoTypeScriptModule from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

const monacoTypeScript =
  monacoTypeScriptModule as unknown as typeof import("monaco-editor").typescript;

export const MONACO_BUNDLER_MODULE_RESOLUTION = 100;

export const MONACO_REACT_EXTRA_LIBS = [
  {
    filePath: "file:///node_modules/@types/react/index.d.ts",
    content: `declare module "react" {
  export type ReactNode = unknown;

  export interface FunctionComponent<P = {}> {
    (props: P): ReactNode;
  }

  export type FC<P = {}> = FunctionComponent<P>;

  export interface StrictModeProps {
    children?: ReactNode;
  }

  export const StrictMode: FC<StrictModeProps>;

  export function useState<S>(
    initialState: S | (() => S),
  ): [S, (value: S | ((currentState: S) => S)) => void];
}`,
  },
  {
    filePath: "file:///node_modules/@types/react-dom/client.d.ts",
    content: `declare module "react-dom/client" {
  export interface Root {
    render(children: unknown): void;
    unmount(): void;
  }

  export function createRoot(container: Element | DocumentFragment): Root;
}`,
  },
  {
    filePath: "file:///node_modules/@types/react/jsx-runtime.d.ts",
    content: `declare module "react/jsx-runtime" {
  export namespace JSX {
    type Element = unknown;

    interface IntrinsicElements {
      [elementName: string]: any;
    }
  }

  export const Fragment: unknown;

  export function jsx(type: unknown, props: unknown, key?: unknown): unknown;
  export function jsxs(type: unknown, props: unknown, key?: unknown): unknown;
}`,
  },
  {
    filePath: "file:///src/vite-env.d.ts",
    content: `declare module "*.css";
declare module "*.svg" {
  const source: string;
  export default source;
}`,
  },
] as const;

export function getMonacoCompilerOptions() {
  return {
    allowImportingTsExtensions: true,
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: monacoTypeScript.JsxEmit.ReactJSX,
    module: monacoTypeScript.ModuleKind.ESNext,
    moduleResolution: MONACO_BUNDLER_MODULE_RESOLUTION,
    noEmit: true,
    resolvePackageJsonExports: true,
    resolvePackageJsonImports: true,
    target: monacoTypeScript.ScriptTarget.ESNext,
    verbatimModuleSyntax: true,
  };
}

export function defineNextEditorTheme(monaco: Monaco) {
  monaco.editor.defineTheme("next-editor-dark", {
    base: "vs-dark",
    inherit: false,
    rules: [
      { token: "", foreground: "D4D4D4", background: "181d24" },
      { token: "invalid", foreground: "D4D4D4" },
      { token: "emphasis", fontStyle: "italic" },
      { token: "strong", fontStyle: "bold" },
      { token: "property", foreground: "F7FAFC" },
      { token: "variable", foreground: "e8e6cb" },
      { token: "variable.predefined", foreground: "ff9696" },
      { token: "variable.parameter", foreground: "9CDCFE" },
      { token: "identifier", foreground: "9dcbeb" },
      { token: "accessor", foreground: "F3F3F3" },
      { token: "identifier.const", foreground: "c1a5d6" },
      { token: "identifier.constant", foreground: "c1a5d6" },
      { token: "identifier.const.class", foreground: "75AAFF" },
      { token: "identifier.class", foreground: "75AAFF" },
      { token: "identifier.classname", foreground: "75AAFF" },
      { token: "identifier.const.tag", foreground: "75AAFF" },
      { token: "identifier.decl", foreground: "75AAFF" },
      { token: "identifier.tag", foreground: "75AAFF" },
      { token: "identifier.tagname", foreground: "75AAFF" },
      { token: "identifier.def", foreground: "75AAFF" },
      { token: "identifier.key", foreground: "a7c9de" },
      { token: "identifier.env", foreground: "ff9696" },
      { token: "identifier.special", foreground: "ffdb59" },
      { token: "identifier.import", foreground: "91b7ea" },
      { token: "identifier.symbol", foreground: "ff9696" },
      { token: "decorator.name", foreground: "9dcbeb" },
      { token: "decorator.modifier.name", foreground: "F3F3F3" },
      { token: "entity.name", foreground: "75AAFF" },
      { token: "entity.name.type", foreground: "75AAFF" },
      { token: "entity.name.function", foreground: "75AAFF" },
      { token: "entity.name.tag", foreground: "e9e19b" },
      { token: "path", foreground: "7da4b7" },
      { token: "self", foreground: "63b3ed" },
      { token: "this", foreground: "63b3ed" },
      { token: "storage.type.function", foreground: "ff9696" },
      { token: "storage.type.class", foreground: "ff9696" },
      { token: "comment", foreground: "5D6E7A", fontStyle: "italic" },
      { token: "operator", foreground: "ff9696" },
      { token: "number", foreground: "29a7e4" },
      { token: "number.hex", foreground: "29a7e4" },
      { token: "numeric.css", foreground: "29a7e4" },
      { token: "regexp", foreground: "FD9231" },
      { token: "regexp.escape", foreground: "FFB26D" },
      { token: "annotation", foreground: "cc6666" },
      { token: "type", foreground: "3DC9B0" },
      { token: "boolean", foreground: "29a7e4" },
      { token: "unit", foreground: "ff8c8c" },
      { token: "constant.numeric", foreground: "29a7e4" },
      { token: "constant.language.boolean", foreground: "29a7e4" },
      { token: "delimiter", foreground: "DCDCDC" },
      { token: "delimiter.access.imba", foreground: "DCDCDB" },
      { token: "delimiter.html", foreground: "808080" },
      { token: "delimiter.xml", foreground: "808080" },
      { token: "delimiter.eq.tag", foreground: "ea9b7c" },
      { token: "tag", foreground: "e9e19b" },
      { token: "tag.name", foreground: "e9e19b" },
      { token: "tag.open", foreground: "9d9755" },
      { token: "tag.close", foreground: "9d9755" },
      { token: "tag.attribute", foreground: "e9e19b" },
      { token: "tag.mixin", foreground: "ffc87c" },
      { token: "tag.reference", foreground: "ffae86" },
      { token: "tag.attribute.listener", foreground: "e9e19b" },
      { token: "tag.attribute.modifier", foreground: "e9e19b" },
      { token: "tag.operator", foreground: "ff9696" },
      { token: "tag.event", foreground: "f3d8b5" },
      { token: "paren.open.tag", foreground: "e9e19b" },
      { token: "paren.close.tag", foreground: "e9e19b" },
      { token: "meta.scss", foreground: "A79873" },
      { token: "meta.tag", foreground: "e9e19b" },
      { token: "metatag", foreground: "DD6A6F" },
      { token: "metatag.content.html", foreground: "9CDCFE" },
      { token: "metatag.html", foreground: "569CD6" },
      { token: "metatag.xml", foreground: "569CD6" },
      { token: "metatag.php", fontStyle: "bold" },
      { token: "key", foreground: "a7c9de" },
      { token: "operator.assign.key", foreground: "a7c9de" },
      { token: "string.key.json", foreground: "9CDCFE" },
      { token: "string.value.json", foreground: "CE9178" },
      { token: "attribute.name", foreground: "a7c9de" },
      { token: "attribute.value", foreground: "29a7e4" },
      { token: "attribute.value.number.css", foreground: "29a7e4" },
      { token: "attribute.value.unit.css", foreground: "29a7e4" },
      { token: "attribute.value.hex.css", foreground: "29a7e4" },
      { token: "string", foreground: "7da4b7" },
      { token: "string.sql", foreground: "7da4b7" },
      { token: "keyword", foreground: "ff9696" },
      { token: "keyword.flow", foreground: "ff9696" },
      { token: "keyword.json", foreground: "ff9696" },
      { token: "keyword.flow.scss", foreground: "ff9696" },
      { token: "operator.scss", foreground: "909090" },
      { token: "operator.sql", foreground: "778899" },
      { token: "operator.swift", foreground: "909090" },
      { token: "predefined.sql", foreground: "FF00FF" },
      { token: "entity.name.selector.css", foreground: "e9e19b" },
      { token: "support.type.property-name.css", foreground: "75AAFF" },
      { token: "meta.object-literal.key", foreground: "a7c9de" },
      { token: "style.selector", foreground: "e9e19b" },
      { token: "style.property", foreground: "e0ade3" },
      { token: "style.property.modifier", foreground: "df8de4" },
      { token: "style.mixin", foreground: "ffc87c" },
      { token: "delimiter.style", foreground: "dbaadf" },
      { token: "style.value", foreground: "a49feb" },
      { token: "style.value.size", foreground: "ff8c8c" },
      { token: "style.start-operator", foreground: "6d829b" },
      { token: "style.open", foreground: "e9e19b" },
      { token: "style.close", foreground: "e9e19b" },
    ],
    colors: {
      foreground: "#D4D4D4",
      "editor.background": "#181d24",
      "editorGutter.background": "#181d24",
      "editor.selectionBackground": "#30455f",
      "editorLineNumber.foreground": "#3b4750",
      "editorWidget.background": "#2d3748",
      "editorWidget.border": "#222a38",
      "list.focusBackground": "#33393f",
      "list.hoverBackground": "#181d24",
      "list.highlightForeground": "#ffffff",
      "input.foreground": "#ffffff",
      "editorSuggestWidget.foreground": "#D4D4D4",
      "editorHoverWidget.background": "#2d3748",
      "editorHoverWidget.border": "#222a38",
      "editorError.foreground": "#f56565",
      "editorCursor.foreground": "#ffed4f",
      "widget.shadow": "#252d37",
      "input.background": "#202732",
      "input.border": "#2a323f",
    },
  });
}

export const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 14,
  lineNumbers: "on" as const,
  roundedSelection: false,
  scrollBeyondLastLine: true,
  readOnly: false, // Keep editor writable to allow cursor blinking
  cursorStyle: "line" as const,
  renderValidationDecorations: "off" as const,
  automaticLayout: true,
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  acceptSuggestionOnEnter: "off" as const,
  tabCompletion: "off" as const,
  wordBasedSuggestions: "currentDocument" as const,
  parameterHints: { enabled: false },
  fontWeight: "normal" as const,
  hover: { enabled: false },
  contextmenu: false,
  folding: false,
  foldingHighlight: false,
  unfoldOnClickAfterEndOfLine: false,
  showUnused: false,
  occurrencesHighlight: "off" as const,
  selectionHighlight: false,
  renderLineHighlight: "none" as const,
  fontFamily: "Source Code Pro",
  fontLigatures: false,
  wrappingIndent: "same" as const,
  dragAndDrop: false,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  lineNumbersMinChars: 3,
  glyphMargin: false,
  lineDecorationsWidth: "1ch" as const,
  colorDecorators: false,
  guides: {
    indentation: false,
  },
  renderWhitespace: "selection" as const,
  matchBrackets: "never" as const,
  links: false,
  padding: { top: 12 },
  scrollbar: {
    useShadows: false,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    horizontal: "hidden" as const,
  },
  unicodeHighlight: {
    ambiguousCharacters: false,
  },
} as const;

export function getEditorOptions(isPlaying: boolean) {
  return {
    ...EDITOR_OPTIONS,
    cursorBlinking: isPlaying ? ("solid" as const) : ("smooth" as const),
  };
}
