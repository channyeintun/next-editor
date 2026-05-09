import { memo } from "react";
import {
  useNextEditorActions,
  useNextEditorMetadata,
} from "../hooks/useNextEditorContext";
import {
  useWebContainerRuntimeActions,
  useWebContainerRuntimeMetadata,
} from "../hooks/useWebContainerRuntime";
import SlidesButton from "./SlidesButton";

const RuntimeControls = memo(function RuntimeControls() {
  const { startRuntime, resetRuntime } = useWebContainerRuntimeActions();
  const { status, previewUrl, isSupported, errorMessage } =
    useWebContainerRuntimeMetadata();

  const isBusy =
    status === "booting" ||
    status === "mounting" ||
    status === "installing" ||
    status === "starting";
  const canStart = isSupported && (status === "idle" || status === "error");

  const handleClick = async () => {
    if (status === "ready") {
      resetRuntime();
      return;
    }

    if (canStart) {
      await startRuntime();
    }
  };

  const buttonLabel =
    status === "ready"
      ? "Reset Runtime"
      : isBusy
        ? "Starting Runtime"
        : "Start Runtime";

  const statusLabel = errorMessage
    ? `Runtime error: ${errorMessage}`
    : previewUrl
      ? `Runtime ready: ${previewUrl}`
      : `Runtime ${status}`;

  return (
    <div className="flex items-center gap-2">
      <span className="max-w-72 truncate rounded bg-slate-800/80 px-2 py-1 text-[11px] text-slate-300">
        {isSupported
          ? statusLabel
          : "Runtime unavailable: cross-origin isolation required"}
      </span>
      <button
        onClick={handleClick}
        disabled={isBusy || (!canStart && status !== "ready")}
        className="px-3 py-1 text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
      >
        {buttonLabel}
      </button>
    </div>
  );
});

// Separate component for Export button to isolate currentRecording subscription
const ExportButton = memo(function ExportButton() {
  const { exportAsFile } = useNextEditorActions();
  const { currentRecording } = useNextEditorMetadata();

  const handleExport = async () => {
    if (currentRecording) {
      try {
        await exportAsFile(currentRecording);
      } catch (error) {
        console.error("Export failed:", error);
      }
    }
  };

  return (
    <button
      onClick={handleExport}
      disabled={!currentRecording}
      className="px-3 py-1 text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors"
    >
      Export
    </button>
  );
});

// Separate component for Import button
const ImportButton = memo(function ImportButton() {
  const { importFromFile, loadRecording } = useNextEditorActions();

  const handleImport = async () => {
    try {
      const importedRecordings = await importFromFile();
      if (importedRecordings.length > 0) {
        loadRecording(importedRecordings[0]);
      }
    } catch (error) {
      console.error("Import failed:", error);
    }
  };

  return (
    <button
      onClick={handleImport}
      className="px-3 py-1 text-xs text-slate-300 hover:text-white bg-slate-700 hover:bg-slate-600 rounded transition-colors"
    >
      Import
    </button>
  );
});

// Separate header component to isolate re-renders from Monaco
interface EditorHeaderProps {
  showImportExport: boolean;
}

const EditorHeader = memo(function EditorHeader({
  showImportExport,
}: EditorHeaderProps) {
  return (
    <div className="bg-[#11141c] px-4 py-1.5 flex items-center justify-between">
      <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
        Editor
      </span>
      <div className="flex items-center gap-2">
        <RuntimeControls />
        {showImportExport && (
          <>
            <ImportButton />
            <ExportButton />
            <div className="w-[1px] h-4 bg-slate-700 mx-1" />
            <SlidesButton />
          </>
        )}
      </div>
    </div>
  );
});

export default EditorHeader;
