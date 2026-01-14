import React, { useState, useCallback } from 'react';
import type { Recording } from '../use-next-editor/src';

interface SnapshotEditorProps {
  recording: Recording;
  onSave: (editedRecording: Recording) => void;
  onCancel: () => void;
  isVisible: boolean;
  mode?: 'edit' | 'export';
}

const SnapshotEditor: React.FC<SnapshotEditorProps> = ({
  recording,
  onSave,
  onCancel,
  isVisible,
  mode = 'export'
}) => {
  const [jsonText, setJsonText] = useState(() => {
    const recordingCopy = {
      ...recording,
      audioBlob: recording.audioBlob ? '[AudioBlob]' : undefined
    };
    return JSON.stringify(recordingCopy, null, 2);
  });
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(() => {
    try {
      const parsed = JSON.parse(jsonText);
      
      // Restore audioBlob from original recording
      const editedRecording: Recording = {
        ...parsed,
        audioBlob: recording.audioBlob
      };

      // Validate required fields
      if (!editedRecording.id || !editedRecording.snapshots || !Array.isArray(editedRecording.snapshots)) {
        throw new Error('Invalid recording format: missing required fields');
      }

      setError(null);
      onSave(editedRecording);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
    }
  }, [jsonText, recording.audioBlob, onSave]);

  const handleJsonChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonText(e.target.value);
    setError(null);
  }, []);

  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-lg font-semibold text-gray-800">
            {mode === 'edit' ? 'Edit Recording JSON' : 'Edit Recording Snapshot'}
          </h2>
          <button
            onClick={onCancel}
            className="text-gray-500 hover:text-gray-700 text-xl font-bold"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 p-4 overflow-hidden">
          <div className="mb-3">
            <p className="text-sm text-gray-600 mb-2">
              Edit the recording data below. Audio blob is preserved automatically.
            </p>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded mb-3">
                {error}
              </div>
            )}
          </div>

          <textarea
            value={jsonText}
            onChange={handleJsonChange}
            className="w-full h-96 p-3 border border-gray-300 rounded-md font-mono text-sm text-gray-900 bg-gray-50 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Recording JSON data..."
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 p-4 border-t">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-gray-600 hover:text-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!!error}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400 transition-colors"
          >
            {mode === 'edit' ? 'Save Changes' : 'Save & Export'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SnapshotEditor;