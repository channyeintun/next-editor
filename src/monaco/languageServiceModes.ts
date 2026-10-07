import type { ModeConfiguration as CssModeConfiguration } from "monaco-editor/languages/features/css/register";
import type { ModeConfiguration as HtmlModeConfiguration } from "monaco-editor/languages/features/html/register";
import type { ModeConfiguration as TypeScriptModeConfiguration } from "monaco-editor/languages/features/typescript/register";

interface LanguageServiceDefaults<ModeConfiguration> {
  readonly modeConfiguration: ModeConfiguration;
  setModeConfiguration(modeConfiguration: ModeConfiguration): void;
}

export interface WorkerLanguageServices {
  typescript: LanguageServiceDefaults<TypeScriptModeConfiguration>;
  javascript: LanguageServiceDefaults<TypeScriptModeConfiguration>;
  css: LanguageServiceDefaults<CssModeConfiguration>;
  html: LanguageServiceDefaults<HtmlModeConfiguration>;
}

/**
 * Unregisters the language-service features whose results the code editor never
 * shows, so that a lesson only starts a language worker when someone asks it
 * for something (completion, go-to-definition, rename, format).
 *
 * Monaco registers every feature by default, and some of them start the worker
 * unprompted. A diagnostics adapter fetches the worker as soon as a model of its
 * language exists, and again after every edit, before it reads the diagnostics
 * options — so `noSyntaxValidation` or CSS `validate: false` never kept the
 * worker from starting. TypeScript's inlay hints and code actions then make the
 * worker build a whole program over the lib .d.ts files. None of it is visible:
 * markers are never painted (`renderValidationDecorations: "off"`), the inlay-hint
 * preferences are all unset, and TS code fixes need markers. For passive playback
 * of a JS/TS lesson that was the 1.5 MB-gzip ts.worker and ~60 MB of worker heap.
 *
 * Must run before the first model of each language exists: tsMode reads the mode
 * configuration once, when the language first activates.
 *
 * JSON keeps its diagnostics on purpose: the API client's request-body editor is
 * an editable JSON editor that paints them.
 */
export function disableUnseenLanguageFeatures({
  typescript,
  javascript,
  css,
  html,
}: WorkerLanguageServices) {
  [typescript, javascript].forEach((defaults) => {
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      diagnostics: false,
      inlayHints: false,
      codeActions: false,
    });
  });
  css.setModeConfiguration({ ...css.modeConfiguration, diagnostics: false });
  // `links: true` in the editor options would otherwise ask html.worker for the
  // file's hrefs on every edit. Plain URLs stay clickable through the editor
  // worker's own link detection. Monaco 0.57 registers no HTML diagnostics
  // adapter; turning it off keeps it that way if a later version adds one.
  html.setModeConfiguration({ ...html.modeConfiguration, diagnostics: false, links: false });
}
