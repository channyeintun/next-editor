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
    /** What a name token is to the scope it is in; null for a token that is not an identifier (a property, a label in `break`). */
    identifierRole: number | null;
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
    questionDot: number;
    braceL: number;
    braceR: number;
    parenL: number;
    parenR: number;
    colon: number;
    question: number;
    eq: number;
    assign: number;
    preIncDec: number;
    postIncDec: number;
    dollarBraceL: number;
    string: number;
    _case: number;
    _delete: number;
    _in: number;
    _declare: number;
  };
}

declare module "sucrase/dist/esm/parser/tokenizer/index.js" {
  export const IdentifierRole: {
    Access: number;
    ExportAccess: number;
    ObjectShorthand: number;
    ObjectKey: number;
    ImportAccess: number;
  };
}

declare module "sucrase/dist/esm/parser/tokenizer/keywords.js" {
  export const ContextualKeyword: {
    _global: number;
    _module: number;
    _namespace: number;
  };
}
