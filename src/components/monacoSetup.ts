// Self-hosted, trimmed Monaco.
//
// By default @monaco-editor/react loads the full monaco-editor runtime from a
// CDN, which (a) bundles all ~85 languages and (b) is a cross-origin script that
// the app's `Cross-Origin-Embedder-Policy: require-corp` header would otherwise
// have to special-case. Instead we bundle Monaco ourselves and ship only the
// languages this editor actually produces (see `inferLanguageFromPath` in
// ../types/workspace.ts): typescript, javascript, json, css, html, markdown.
//
// Importing this module for its side effects is enough; CodeEditor.tsx does so
// before it renders <Editor>, which is the only @monaco-editor/react render site.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

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
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
// Markdown has no worker-backed service — this grammar is all it needs.
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";

// Worker-backed rich services. The typescript contribution also exposes
// `monaco.languages.typescript`, which CodeEditor.tsx uses to set compiler
// options and extra libs. JSON is self-contained: language/json registers its
// own id and tokenizes via its worker, so it needs no basic-languages grammar.
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";

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

self.MonacoEnvironment = monacoEnvironment;

// Point @monaco-editor/react at our bundled instance instead of the CDN. Must
// run before <Editor> mounts (and thus calls loader.init()), which it does
// because this is a module-load side effect of importing CodeEditor.tsx.
loader.config({ monaco });
