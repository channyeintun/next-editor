// Self-hosted, trimmed Monaco. Importing this module configures the workers,
// theme, and TypeScript defaults before any raw editor instance is created.
import * as monaco from "monaco-editor/editor";
import { NEXT_EDITOR_MONACO_THEME, defineNextEditorTheme } from "./theme";
import { configureMonacoTypeScript } from "./typescriptDefaults";
import { registerKiteLanguage } from "./kiteLanguage";
import { registerZigLanguage } from "./zigLanguage";
import { registerHaskellLanguage } from "./haskellLanguage";
import { registerAsmLanguage } from "./asmLanguage";

// Every standalone editor feature (find, multi-cursor, bracket matching, …) but
// no bundled languages. Importing the package root instead would pull in all of them.
import "monaco-editor/features/register.all";
// The feature registry leaves out three contributions that Monaco's full entry
// still loads by path — move-selected-text, paste-as and document semantic
// tokens. Keep them, as the edcore.main barrel this replaced did.
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";

// Monaco splits most languages into two independent pieces:
//   - languages/definitions/*: registers the language id + a Monarch grammar.
//     This is what actually produces syntax highlighting (token colors).
//   - languages/features/*: attaches a worker-backed service (validation,
//     completion, formatting) via onLanguage(), which only fires once the id
//     above exists.
// Importing only languages/features/* gives workers but NO highlighting — the
// definition must be registered too.

// Syntax highlighting + language-id registration.
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/html/register";
// Markdown has no worker-backed service — this grammar is all it needs.
import "monaco-editor/languages/definitions/markdown/register";
// Go likewise ships only a Monarch grammar (no worker service) — used by the
// Go Playground lesson type, whose code executes remotely, not in Monaco.
import "monaco-editor/languages/definitions/go/register";
// Kotlin: same story, for the Kotlin Playground lesson type.
import "monaco-editor/languages/definitions/kotlin/register";
// Rust: same story, for the Rust Playground lesson type.
import "monaco-editor/languages/definitions/rust/register";
// Python: grammar only, for the WebContainer python lesson type — execution
// happens through the container's WASI interpreter, not Monaco.
import "monaco-editor/languages/definitions/python/register";
// Zig, Haskell, Kite and x86-64 assembly have no Monaco grammar to import —
// languages/definitions/ carries none of the four, and its only assembly mode is
// `mips` — so monaco/zigLanguage.ts, monaco/haskellLanguage.ts,
// monaco/kiteLanguage.ts and monaco/asmLanguage.ts are first-party Monarch
// grammars, registered by ensureMonacoRuntimeInitialized below rather than by
// an import side effect.

// Worker-backed rich services. JSON is self-contained: its feature registers
// its own id and tokenizes via its worker, so it needs no language definition.
import "monaco-editor/languages/features/typescript/register";
import { cssDefaults } from "monaco-editor/languages/features/css/register";
import "monaco-editor/languages/features/html/register";
import "monaco-editor/languages/features/json/register";

import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/languages/features/json/json.worker?worker";
import CssWorker from "monaco-editor/languages/features/css/css.worker?worker";
import HtmlWorker from "monaco-editor/languages/features/html/html.worker?worker";

// Workers are bundled as same-origin chunks, so they satisfy the app's
// COEP: require-corp header without any cross-origin worker configuration.
const monacoEnvironment: monaco.Environment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
        return new CssWorker();
      case "html":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

const globalScope = self as typeof self & {
  __nextEditorMonacoRuntimeInitialized?: boolean;
};

function ensureMonacoRuntimeInitialized() {
  if (globalScope.__nextEditorMonacoRuntimeInitialized) {
    return;
  }

  globalScope.__nextEditorMonacoRuntimeInitialized = true;
  self.MonacoEnvironment = monacoEnvironment;
  defineNextEditorTheme(monaco);
  // Activate immediately so the first editor never paints Monaco's default theme.
  monaco.editor.setTheme(NEXT_EDITOR_MONACO_THEME);
  configureMonacoTypeScript();
  // CSS lint markers are never painted either (see configureMonacoTypeScript).
  cssDefaults.setOptions({ ...cssDefaults.options, validate: false });
  registerZigLanguage();
  registerHaskellLanguage();
  registerKiteLanguage();
  registerAsmLanguage();
}

ensureMonacoRuntimeInitialized();

export { monaco };
export type Monaco = typeof monaco;
