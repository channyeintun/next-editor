// Self-hosted, trimmed Monaco. Importing this module configures the workers,
// theme, and TypeScript defaults before any raw editor instance is created.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import { NEXT_EDITOR_MONACO_THEME, defineNextEditorTheme, setActiveTheme } from "./theme";
import { configureMonacoTypeScript } from "./typescriptDefaults";
import { registerKiteLanguage } from "./kiteLanguage";
import { registerZigLanguage } from "./zigLanguage";
import { registerHaskellLanguage } from "./haskellLanguage";
import { registerAsmLanguage } from "./asmLanguage";

// Every standalone editor feature (find, multi-cursor, bracket matching, …) but
// no bundled languages. Importing editor.main instead would pull in all of them.
import "monaco-editor/esm/vs/editor/edcore.main";

// Monaco splits most languages into two independent pieces:
//   - basic-languages/*: registers the language id + a Monarch grammar. This is
//     what actually produces syntax highlighting (token colors).
//   - language/*: attaches a worker-backed service (validation, completion,
//     formatting) via onLanguage(), which only fires once the id above exists.
// Importing only language/* gives workers but NO highlighting — the basic
// grammar must be registered too.

// Syntax highlighting + language-id registration.
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
// Markdown has no worker-backed service — this grammar is all it needs.
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
// Go likewise ships only a Monarch grammar (no worker service) — used by the
// Go Playground lesson type, whose code executes remotely, not in Monaco.
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
// Kotlin: same story, for the Kotlin Playground lesson type.
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
// Rust: same story, for the Rust Playground lesson type.
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
// Python: grammar only, for the WebContainer python lesson type — execution
// happens through the container's WASI interpreter, not Monaco.
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
// Zig, Haskell, Kite and x86-64 assembly have no Monaco grammar to import —
// basic-languages/ carries none of the four, and its only assembly mode is
// `mips` — so monaco/zigLanguage.ts, monaco/haskellLanguage.ts,
// monaco/kiteLanguage.ts and monaco/asmLanguage.ts are first-party Monarch
// grammars, registered by ensureMonacoRuntimeInitialized below rather than by
// an import side effect.

// Worker-backed rich services. JSON is self-contained: language/json registers
// its own id and tokenizes via its worker, so it needs no basic grammar.
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";

import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";

// Workers are bundled as same-origin chunks, so they satisfy the app's
// COEP: require-corp header without any cross-origin worker configuration.
const monacoEnvironment: monaco.Environment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
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
  // Activate immediately so the first editor never paints Monaco's default
  // theme. Routed through setActiveTheme to keep it the only setTheme caller.
  setActiveTheme(NEXT_EDITOR_MONACO_THEME);
  configureMonacoTypeScript();
  registerZigLanguage();
  registerHaskellLanguage();
  registerKiteLanguage();
  registerAsmLanguage();
}

ensureMonacoRuntimeInitialized();

export { monaco };
export type Monaco = typeof monaco;
