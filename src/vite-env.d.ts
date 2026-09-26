/// <reference types="vite/client" />

declare module "virtual:rrweb-recorder-bundle" {
  const bundle: string;
  export default bundle;
}

// Editor contributions Monaco ships without a sibling .d.ts. We only import them
// for their side effects (see src/monaco/runtime.ts), so untyped ambient modules
// are enough to satisfy noUncheckedSideEffectImports.
declare module "monaco-editor/editor/contrib/caretOperations/browser/caretOperations";
declare module "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution";
declare module "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens";
