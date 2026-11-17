// Types for the parts of sucrase's parser the loader reads (transform.ts). The
// package declares them only beside its CommonJS build; the loader imports the
// ES module build, the one `import "sucrase"` bundles, so there is one parser.
declare module "sucrase/dist/esm/parser/index.js" {
  export interface SucraseToken {
    type: number;
    contextualKeyword: number;
    start: number;
    end: number;
    isType: boolean;
  }
  export function parse(
    input: string,
    isJSXEnabled: boolean,
    isTypeScriptEnabled: boolean,
    isFlowEnabled: boolean,
  ): { tokens: SucraseToken[] };
}

declare module "sucrase/dist/esm/parser/tokenizer/types.js" {
  export const TokenType: {
    at: number;
    name: number;
    dot: number;
    braceL: number;
    braceR: number;
    dollarBraceL: number;
    string: number;
    _declare: number;
  };
}

declare module "sucrase/dist/esm/parser/tokenizer/keywords.js" {
  export const ContextualKeyword: {
    _global: number;
    _module: number;
    _namespace: number;
  };
}
