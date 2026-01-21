import { memo } from 'react';
import { useNextEditorActions, useNextEditorMetadata } from '../hooks/useNextEditorContext';
import SlidesButton from './SlidesButton';

// Separate component for Export button to isolate currentRecording subscription
const ExportButton = memo(function ExportButton() {
    const { exportAsFile } = useNextEditorActions();
    const { currentRecording } = useNextEditorMetadata();

    const handleExport = async () => {
        if (currentRecording) {
            try {
                await exportAsFile(currentRecording);
            } catch (error) {
                console.error('Export failed:', error);
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
            console.error('Import failed:', error);
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

const EditorHeader = memo(function EditorHeader({ showImportExport }: EditorHeaderProps) {
    return (
        <div className="bg-slate-800 px-4 py-1.5 flex items-center justify-between border-b border-slate-700">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Editor</span>
            {showImportExport && (
                <div className="flex items-center gap-2">
                    <ImportButton />
                    <ExportButton />
                    <div className="w-[1px] h-4 bg-slate-700 mx-1" />
                    <SlidesButton />
                </div>
            )}
        </div>
    );
});

export default EditorHeader;
