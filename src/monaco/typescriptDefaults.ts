import * as monacoTypeScriptModule from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

const monacoTypeScript =
  monacoTypeScriptModule as unknown as typeof import("monaco-editor").typescript;

let hasConfiguredMonacoTypeScript = false;

export const MONACO_BUNDLER_MODULE_RESOLUTION = 100;

export const MONACO_EXTRA_LIBS = [
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

export function configureMonacoTypeScript() {
  if (hasConfiguredMonacoTypeScript) {
    return;
  }

  const compilerOptions = getMonacoCompilerOptions();
  const defaults = [monacoTypeScript.typescriptDefaults, monacoTypeScript.javascriptDefaults];

  defaults.forEach((currentDefaults) => {
    currentDefaults.setEagerModelSync(true);
    currentDefaults.setCompilerOptions(compilerOptions);

    MONACO_EXTRA_LIBS.forEach(({ content, filePath }) => {
      currentDefaults.addExtraLib(content, filePath);
    });
  });

  hasConfiguredMonacoTypeScript = true;
}
