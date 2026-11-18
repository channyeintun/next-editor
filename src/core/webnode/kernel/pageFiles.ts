// The page's own file requests (`fs.*` in api.ts): how the editor reads,
// saves and syncs a project's files. They go to the filesystem unchecked, so a
// mode a learner gave a file or a directory never stops the editor.
import { O_CREAT, O_TRUNC, O_WRONLY } from "./vfs/types";
import type { DirEntry, VfsApi } from "./vfs/types";

/** The file requests the page makes. A relative path is relative to the project directory. */
export interface PageFiles {
  readFile(path: string): Uint8Array;
  /** Writes the whole file, creating it (0644) or replacing its contents (its mode stays). */
  writeFile(path: string, data: Uint8Array): void;
  readdir(path: string): DirEntry[];
  /** Makes a directory (0755); with `recursive`, the first one it made, as mkdir does. */
  mkdir(path: string, recursive: boolean): string | undefined;
  rm(path: string, recursive: boolean, force: boolean): void;
  rename(from: string, to: string): void;
}

/**
 * The page's file requests on `fs`, which must be the unchecked view of the
 * filesystem (`PermissionedVfs.privileged`). `resolve` makes a path the page
 * gave absolute.
 */
export function createPageFiles(fs: VfsApi, resolve: (path: string) => string): PageFiles {
  return {
    readFile: (path) => fs.readFile(resolve(path)),
    writeFile: (path, data) =>
      fs.writeFile(resolve(path), data, O_WRONLY | O_CREAT | O_TRUNC, 0o644),
    readdir: (path) => fs.readdir(resolve(path)),
    mkdir: (path, recursive) => fs.mkdir(resolve(path), recursive, 0o755),
    rm: (path, recursive, force) => fs.rm(resolve(path), recursive, force),
    rename: (from, to) => fs.rename(resolve(from), resolve(to)),
  };
}
