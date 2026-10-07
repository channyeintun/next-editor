import { describe, expect, it } from "vite-plus/test";
import { disableUnseenLanguageFeatures } from "./languageServiceModes";

// Monaco 0.57's own defaults (languages/features/*/register.js). The real
// register modules pull in the whole editor, which is mocked under test.
const TYPESCRIPT_MODE_DEFAULTS = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  definitions: true,
  references: true,
  documentHighlights: true,
  rename: true,
  diagnostics: true,
  documentRangeFormattingEdits: true,
  signatureHelp: true,
  onTypeFormattingEdits: true,
  codeActions: true,
  inlayHints: true,
};

const CSS_MODE_DEFAULTS = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  definitions: true,
  references: true,
  documentHighlights: true,
  rename: true,
  colors: true,
  foldingRanges: true,
  diagnostics: true,
  selectionRanges: true,
  documentFormattingEdits: true,
  documentRangeFormattingEdits: true,
};

const HTML_MODE_DEFAULTS = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  links: true,
  documentHighlights: true,
  rename: true,
  colors: true,
  foldingRanges: true,
  selectionRanges: true,
  diagnostics: true,
  documentFormattingEdits: true,
  documentRangeFormattingEdits: true,
};

function createFakeDefaults<ModeConfiguration extends object>(initial: ModeConfiguration) {
  const writes: ModeConfiguration[] = [];

  return {
    writes,
    modeConfiguration: initial,
    setModeConfiguration(modeConfiguration: ModeConfiguration) {
      writes.push(modeConfiguration);
      this.modeConfiguration = modeConfiguration;
    },
  };
}

function configure() {
  // Monaco's TypeScript and JavaScript defaults start from one shared
  // mode-configuration object, as here.
  const services = {
    typescript: createFakeDefaults(TYPESCRIPT_MODE_DEFAULTS),
    javascript: createFakeDefaults(TYPESCRIPT_MODE_DEFAULTS),
    css: createFakeDefaults(CSS_MODE_DEFAULTS),
    html: createFakeDefaults(HTML_MODE_DEFAULTS),
  };

  disableUnseenLanguageFeatures(services);
  return services;
}

describe("disableUnseenLanguageFeatures", () => {
  it("unregisters the TS/JS features that start the worker unprompted", () => {
    const { typescript, javascript } = configure();

    [typescript, javascript].forEach((defaults) => {
      expect(defaults.modeConfiguration).toEqual({
        ...TYPESCRIPT_MODE_DEFAULTS,
        diagnostics: false,
        inlayHints: false,
        codeActions: false,
      });
    });
  });

  it("keeps the on-demand TS features an author can still ask for", () => {
    const { typescript } = configure();

    expect(typescript.modeConfiguration).toMatchObject({
      completionItems: true,
      definitions: true,
      references: true,
      rename: true,
      documentSymbols: true,
      documentRangeFormattingEdits: true,
    });
  });

  it("turns off CSS diagnostics and HTML links, keeping everything else", () => {
    const { css, html } = configure();

    expect(css.modeConfiguration).toEqual({ ...CSS_MODE_DEFAULTS, diagnostics: false });
    expect(html.modeConfiguration).toEqual({
      ...HTML_MODE_DEFAULTS,
      diagnostics: false,
      links: false,
    });
  });

  it("writes each language once and never mutates Monaco's shared defaults", () => {
    const services = configure();

    Object.values(services).forEach(({ writes }) => {
      expect(writes).toHaveLength(1);
    });
    expect(TYPESCRIPT_MODE_DEFAULTS.diagnostics).toBe(true);
    expect(services.typescript.modeConfiguration).not.toBe(services.javascript.modeConfiguration);
  });
});
