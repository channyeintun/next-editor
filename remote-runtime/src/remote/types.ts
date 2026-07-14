export interface FileSystemTree {
  [name: string]: DirectoryNode | FileNode | SymlinkNode;
}

export interface DirectoryNode {
  directory: FileSystemTree;
}

export interface FileNode {
  file: { contents: string | Uint8Array };
}

export interface SymlinkNode {
  file: { symlink: string };
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | number | boolean>;
  output?: boolean;
  terminal?: { cols: number; rows: number };
}

export interface ExportOptions {
  format?: "json" | "binary" | "zip";
  includes?: string[];
  excludes?: string[];
}

export interface PreviewScriptOptions {
  type?: "module" | "importmap";
  defer?: boolean;
  async?: boolean;
}

export interface RemoteBootOptions {
  coep?: "require-corp" | "credentialless" | "none";
  workdirName?: string;
  forwardPreviewErrors?: boolean | "exceptions-only";
  runtime?: string;
  endpoint?: string;
  idleTimeoutSeconds?: number;
}

export interface RemoteProcessLike {
  exit: Promise<number>;
  input: WritableStream<string>;
  output: ReadableStream<string>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}
