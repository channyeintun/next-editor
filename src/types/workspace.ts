export interface WorkspaceFile {
  path: string;
  name: string;
  language: string;
  content: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  entryFilePath: string;
  files: Record<string, WorkspaceFile>;
}

export const DEFAULT_WORKSPACE_ENTRY_PATH = "index.html";

export const DEFAULT_WORKSPACE_FILE_CONTENT = `<html>
  <h1>Hello world</h1>
</html>`;

export function createSingleFileWorkspace(
  content = DEFAULT_WORKSPACE_FILE_CONTENT,
): WorkspaceProject {
  return {
    id: "default-workspace",
    name: "Next Editor Workspace",
    entryFilePath: DEFAULT_WORKSPACE_ENTRY_PATH,
    files: {
      [DEFAULT_WORKSPACE_ENTRY_PATH]: {
        path: DEFAULT_WORKSPACE_ENTRY_PATH,
        name: "index.html",
        language: "html",
        content,
      },
    },
  };
}
