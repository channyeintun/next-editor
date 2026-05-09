import { memo, useMemo, useState } from "react";
import {
  Check,
  File,
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  Globe,
  Package,
  Palette,
  PencilLine,
  Trash2,
  X,
} from "lucide-react";
import {
  inferLanguageFromPath,
  normalizeWorkspacePath,
  type WorkspaceFile,
} from "../types/workspace";
import {
  useWorkspaceActions,
  useWorkspaceMetadata,
} from "../hooks/useWorkspace";

const FILE_TEMPLATES: Record<string, string> = {
  css: "body {\n  margin: 0;\n}\n",
  html: '<!doctype html>\n<html lang="en">\n  <body>\n  </body>\n</html>\n',
  javascript: "export function main() {\n  return null;\n}\n",
  json: "{}\n",
  markdown: "# New file\n",
  typescript: "export function main(): null {\n  return null;\n}\n",
};

function getDirectoryLabel(path: string): string {
  const segments = normalizeWorkspacePath(path).split("/");
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "root";
}

function getDefaultFileContent(path: string): string {
  const language = inferLanguageFromPath(path);
  return FILE_TEMPLATES[language] ?? "";
}

function getDefaultDraftPath(activeFilePath: string): string {
  const directoryLabel = getDirectoryLabel(activeFilePath);

  if (directoryLabel === "root") {
    return "new-file.js";
  }

  return `${directoryLabel}/new-file.js`;
}

function getFileIcon(file: WorkspaceFile) {
  if (file.path === "package.json") {
    return <Package size={14} className="text-emerald-300" />;
  }

  if (file.language === "css") {
    return <Palette size={14} className="text-pink-300" />;
  }

  if (file.language === "json") {
    return <FileJson2 size={14} className="text-amber-300" />;
  }

  if (file.language === "html") {
    return <Globe size={14} className="text-sky-300" />;
  }

  if (file.language === "markdown") {
    return <FileText size={14} className="text-violet-300" />;
  }

  if (file.language === "javascript" || file.language === "typescript") {
    return <FileCode2 size={14} className="text-cyan-300" />;
  }

  return <FileText size={14} className="text-slate-300" />;
}

const FileSidebar = memo(function FileSidebar() {
  const [draftPath, setDraftPath] = useState("");
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const { createFile, deleteFile, renameFile, setActiveFilePath } =
    useWorkspaceActions();
  const { activeFilePath, fileCount, files, projectName } =
    useWorkspaceMetadata();
  const groupedFiles = useMemo(
    () =>
      files.reduce<Record<string, WorkspaceFile[]>>((groups, file) => {
        const directoryLabel = getDirectoryLabel(file.path);
        groups[directoryLabel] = groups[directoryLabel] ?? [];
        groups[directoryLabel].push(file);
        return groups;
      }, {}),
    [files],
  );
  const hasPendingCreate = editingPath === "__new__";

  const resetDraft = () => {
    setEditingPath(null);
    setDraftPath("");
  };

  const handleCreateFile = () => {
    setEditingPath("__new__");
    setDraftPath(getDefaultDraftPath(activeFilePath));
  };

  const handleRenameFile = (path: string) => {
    setEditingPath(path);
    setDraftPath(path);
  };

  const handleSubmitDraft = () => {
    const nextPath = normalizeWorkspacePath(draftPath);

    if (!nextPath) {
      resetDraft();
      return;
    }

    if (editingPath === "__new__") {
      createFile(nextPath, getDefaultFileContent(nextPath));
      resetDraft();
      return;
    }

    if (!editingPath || nextPath === editingPath) {
      resetDraft();
      return;
    }

    renameFile(editingPath, nextPath);
    resetDraft();
  };

  const handleDeleteFile = (path: string) => {
    const confirmed = window.confirm(`Delete ${path}?`);

    if (!confirmed) {
      return;
    }

    deleteFile(path);
  };

  const handleDraftKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSubmitDraft();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      resetDraft();
    }
  };

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-slate-800 bg-[#11141c] text-slate-100">
      <div className="border-b border-slate-800 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              Files
            </p>
            <p className="mt-1 truncate text-xs text-slate-500">
              {projectName} • {fileCount} files
            </p>
          </div>
          <button
            type="button"
            onClick={handleCreateFile}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 bg-slate-900 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            aria-label="Create file"
            title="Create file"
          >
            <FilePlus2 size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <div className="space-y-4">
          {hasPendingCreate && (
            <div className="mx-2 rounded-md border border-sky-500/40 bg-slate-900 px-3 py-2">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-300">
                <File size={13} />
                New File
              </div>
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draftPath}
                  onChange={(event) => setDraftPath(event.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  className="h-9 flex-1 rounded-md border border-slate-700 bg-[#0d1117] px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={handleSubmitDraft}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 bg-slate-950 text-slate-300 transition-colors hover:border-emerald-500 hover:text-emerald-200"
                  title="Create file"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  onClick={resetDraft}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 bg-slate-950 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                  title="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          {Object.entries(groupedFiles).map(
            ([directoryLabel, directoryFiles]) => (
              <section key={directoryLabel} className="space-y-1.5">
                <div className="px-2 py-1">
                  <p className="truncate text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-500">
                    {directoryLabel}
                  </p>
                </div>
                {directoryFiles.map((file) => {
                  const isActive = file.path === activeFilePath;
                  const isEditing = editingPath === file.path;

                  return (
                    <div key={file.path} className="px-2">
                      {isEditing ? (
                        <div className="rounded-md border border-sky-500/40 bg-slate-900 px-3 py-2">
                          <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-sky-300">
                            Rename File
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              value={draftPath}
                              onChange={(event) =>
                                setDraftPath(event.target.value)
                              }
                              onKeyDown={handleDraftKeyDown}
                              className="h-9 flex-1 rounded-md border border-slate-700 bg-[#0d1117] px-3 text-sm text-slate-100 outline-none transition-colors focus:border-sky-500"
                            />
                            <button
                              type="button"
                              onClick={handleSubmitDraft}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 bg-slate-950 text-slate-300 transition-colors hover:border-emerald-500 hover:text-emerald-200"
                              title="Save rename"
                            >
                              <Check size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={resetDraft}
                              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-700 bg-slate-950 text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                              title="Cancel rename"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`group flex w-full items-center gap-2 rounded-md px-3 py-2 transition-colors ${
                            isActive
                              ? "bg-slate-800 text-white"
                              : "text-slate-300 hover:bg-slate-900 hover:text-white"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveFilePath(file.path)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                              {getFileIcon(file)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">
                                {file.name}
                              </span>
                            </span>
                          </button>
                          <span className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRenameFile(file.path);
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-700 hover:text-white"
                              title={`Rename ${file.name}`}
                            >
                              <PencilLine size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleDeleteFile(file.path);
                              }}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-rose-500/10 hover:text-rose-300"
                              title={`Delete ${file.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ),
          )}
        </div>
      </div>
    </aside>
  );
});

export default FileSidebar;
