/// <reference types="vite/client" />

// Monaco ships this feature barrel without a sibling .d.ts. We only import it
// for its side effects (registering the editor's standalone features), so an
// untyped ambient module is enough to satisfy noUncheckedSideEffectImports.
declare module "monaco-editor/esm/vs/editor/edcore.main";
