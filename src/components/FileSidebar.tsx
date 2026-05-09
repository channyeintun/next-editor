import { memo, useState } from "react";
import {
  FileCode2,
  FileJson2,
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  Package,
  Palette,
  PencilLine,
  Search,
  Trash2,
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
  const [filterQuery, setFilterQuery] = useState("");
  const { createFile, deleteFile, renameFile, setActiveFilePath } =
    useWorkspaceActions();
  const { activeFilePath, fileCount, files, projectName } =
    useWorkspaceMetadata();
  const normalizedQuery = filterQuery.trim().toLowerCase();
  const filteredFiles = files.filter((file) => {
    if (!normalizedQuery) {
      return true;
    }

    return (
      file.path.toLowerCase().includes(normalizedQuery) ||
      file.language.toLowerCase().includes(normalizedQuery)
    );
  });
  const groupedFiles = filteredFiles.reduce<Record<string, WorkspaceFile[]>>(
    (groups, file) => {
      const directoryLabel = getDirectoryLabel(file.path);
      groups[directoryLabel] = groups[directoryLabel] ?? [];
      groups[directoryLabel].push(file);
      return groups;
    },
    {},
  );
  const activeFile = files.find((file) => file.path === activeFilePath) ?? null;

  const handleCreateFile = () => {
    const requestedPath = window.prompt(
      "Create a file in the workspace",
      "src/NewFile.jsx",
    );

    if (!requestedPath) {
      return;
    }

    const nextPath = normalizeWorkspacePath(requestedPath);
    if (!nextPath) {
      return;
    }

    createFile(nextPath, getDefaultFileContent(nextPath));
  };

  const handleRenameFile = () => {
    const requestedPath = window.prompt(
      "Rename the active file",
      activeFilePath,
    );

    if (!requestedPath) {
      return;
    }

    const nextPath = normalizeWorkspacePath(requestedPath);
    if (!nextPath || nextPath === activeFilePath) {
      return;
    }

    renameFile(activeFilePath, nextPath);
  };

  const handleDeleteFile = () => {
    const confirmed = window.confirm(`Delete ${activeFilePath}?`);

    if (!confirmed) {
      return;
    }

    deleteFile(activeFilePath);
  };

  return (
    <aside className="relative flex h-full w-80 shrink-0 flex-col border-r border-slate-800/90 bg-[#0b1120] text-slate-100 shadow-[inset_-1px_0_0_rgba(30,41,59,0.55)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(56,189,248,0.12),_transparent_38%),linear-gradient(180deg,rgba(15,23,42,0.96),rgba(2,6,23,0.98))]" />
      <div className="relative border-b border-slate-800/80 px-4 py-4">
        <div className="rounded-2xl border border-slate-800/80 bg-slate-900/70 p-4 shadow-[0_20px_50px_rgba(2,6,23,0.35)] backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-400">
                <FolderTree size={14} />
                Workspace
              </div>
              <p className="mt-3 truncate text-sm font-semibold text-slate-50">
                {projectName}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {fileCount} files in active project
              </p>
            </div>
            <button
              type="button"
              onClick={handleCreateFile}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700/80 bg-slate-950/80 text-slate-200 shadow-[0_10px_24px_rgba(2,6,23,0.28)] transition-all hover:-translate-y-0.5 hover:border-sky-500/60 hover:text-white"
              aria-label="Create file"
              title="Create file"
            >
              <FilePlus2 size={16} />
            </button>
          </div>

          <label className="mt-4 flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-slate-400 transition-colors focus-within:border-sky-500/60 focus-within:text-sky-300">
            <Search size={14} />
            <input
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="Jump to file"
              className="w-full bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
          </label>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleRenameFile}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-white"
              title="Rename active file"
            >
              <PencilLine size={14} />
              Rename
            </button>
            <button
              type="button"
              onClick={handleDeleteFile}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs font-medium text-rose-200 transition-colors hover:border-rose-500/60 hover:text-rose-100"
              title="Delete active file"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto px-3 py-4">
        <div className="space-y-4">
          {Object.entries(groupedFiles).map(
            ([directoryLabel, directoryFiles]) => (
              <section key={directoryLabel} className="space-y-1.5">
                <div className="px-2">
                  <p className="truncate text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-500">
                    {directoryLabel}
                  </p>
                </div>
                {directoryFiles.map((file) => {
                  const isActive = file.path === activeFilePath;

                  return (
                    <button
                      key={file.path}
                      type="button"
                      onClick={() => setActiveFilePath(file.path)}
                      className={`group relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border px-3 py-3 text-left transition-all ${
                        isActive
                          ? "border-sky-500/40 bg-sky-500/10 text-white shadow-[0_14px_30px_rgba(14,165,233,0.12)]"
                          : "border-transparent bg-slate-950/20 text-slate-300 hover:border-slate-800 hover:bg-slate-900/80 hover:text-white"
                      }`}
                    >
                      <span
                        className={`absolute inset-y-2 left-0 w-1 rounded-full ${
                          isActive ? "bg-sky-400" : "bg-transparent"
                        }`}
                      />
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-800/80 bg-slate-950/80">
                        {getFileIcon(file)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {file.name}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-slate-500 group-hover:text-slate-400">
                          <span>{file.language}</span>
                          <span className="h-1 w-1 rounded-full bg-slate-600" />
                          <span className="truncate">{file.path}</span>
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            ),
          )}

          {filteredFiles.length === 0 && (
            <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/40 px-4 py-6 text-center text-sm text-slate-400">
              No files match this filter.
            </div>
          )}
        </div>
      </div>

      <div className="relative border-t border-slate-800/80 px-4 py-3">
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-slate-200">
              {activeFile?.name ?? "No file selected"}
            </p>
            <p className="truncate text-[11px] uppercase tracking-[0.2em] text-slate-500">
              {activeFile?.path ?? "workspace idle"}
            </p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-300">
            {activeFile?.language ?? "none"}
          </span>
        </div>
      </div>
    </aside>
  );
});

export default FileSidebar;
