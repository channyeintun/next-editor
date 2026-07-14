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
