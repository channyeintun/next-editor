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

const SaveAndRerunControls = memo(function SaveAndRerunControls() {
  const { rerunRunner } = useWebContainerRuntimeActions();
  const { isSupported, runnerConfig, status } =
    useWebContainerRuntimeMetadata();
  const isBusy =
    status === "booting" ||
    status === "mounting" ||
    status === "installing" ||
    status === "starting";

  return (
    <div className="flex items-center gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
        CMD+S to save
      </span>
      <button
        type="button"
        onClick={() => {
          void rerunRunner();
        }}
        disabled={!isSupported || !runnerConfig.enabled || isBusy}
        className="px-3 py-1 text-xs text-emerald-300 hover:text-emerald-200 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors font-semibold"
      >
        RERUN
      </button>
    </div>
  );
});

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
        <SaveAndRerunControls />
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
