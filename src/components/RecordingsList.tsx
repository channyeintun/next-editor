import React, { useState, useEffect } from 'react';
import { useScrimbaContext } from '../hooks/useScrimbaContext';
import type { Recording } from 'use-scrimba';

const RecordingsList: React.FC = () => {
  const { 
    currentRecording, 
    loadRecording, 
    exportAsFile, 
    importFromFile, 
    loadRecordingsFromStorage,
    getStorageStats,
    deleteFromStorage
  } = useScrimbaContext();
  
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [storageStats, setStorageStats] = useState<{ count: number; totalSize: string }>({ count: 0, totalSize: '0 B' });

  // Load recordings from storage on mount
  useEffect(() => {
    const loadRecordings = async () => {
      try {
        const loadedRecordings = await loadRecordingsFromStorage();
        setRecordings(loadedRecordings);
        const stats = await getStorageStats();
        setStorageStats(stats);
      } catch (error) {
        console.warn('Failed to load recordings:', error);
      }
    };
    
    loadRecordings();
  }, [loadRecordingsFromStorage, getStorageStats]);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (milliseconds: number): string => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleLoadRecording = (recording: Recording) => {
    loadRecording(recording);
  };

  const handleExportRecording = async (recording: Recording, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent loading the recording when exporting
    try {
      await exportAsFile(recording, `${recording.name}.json`);
    } catch (error) {
      console.error('Failed to export recording:', error);
      alert('Failed to export recording. Please try again.');
    }
  };

  const handleImportRecording = async () => {
    try {
      const importedRecordings = await importFromFile();
      if (importedRecordings.length > 0) {
        // Refresh the recordings list
        const updatedRecordings = await loadRecordingsFromStorage();
        setRecordings(updatedRecordings);
        const stats = await getStorageStats();
        setStorageStats(stats);
        alert(`Successfully imported ${importedRecordings.length} recording(s)!`);
      }
    } catch (error) {
      console.error('Failed to import recording:', error);
      alert('Failed to import recording. Please check the file format and try again.');
    }
  };

  const handleDeleteRecording = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent loading the recording when deleting
    if (window.confirm('Are you sure you want to delete this recording?')) {
      try {
        // Delete from storage first
        await deleteFromStorage(id);
        
        // Update local state
        const updatedRecordings = recordings.filter(r => r.id !== id);
        setRecordings(updatedRecordings);
        
        // Update storage stats
        const stats = await getStorageStats();
        setStorageStats(stats);
      } catch (error) {
        console.error('Failed to delete recording:', error);
        alert('Failed to delete recording. Please try again.');
      }
    }
  };

  if (recordings.length === 0) {
    return (
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-white text-xl font-semibold">Recordings</h3>
          <button
            onClick={handleImportRecording}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            📁 Import JSON
          </button>
        </div>
        <p className="text-gray-400 italic">No recordings yet. Start recording or import a JSON file to get started!</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-between items-center mb-5">
        <h3 className="text-white text-xl font-semibold">Recordings ({recordings.length})</h3>
        <div className="flex gap-2">
          <div className="text-gray-400 text-xs">
            Storage: {storageStats.totalSize}
          </div>
          <button
            onClick={handleImportRecording}
            className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded text-sm transition-colors"
          >
            📁 Import JSON
          </button>
        </div>
      </div>
      
      <div className="grid grid-cols-1 gap-4">
        {recordings.map((recording) => (
          <div
            key={recording.id}
            className={`bg-gray-700 border-2 rounded-lg p-4 cursor-pointer transition-all duration-200 hover:border-blue-500 hover:-translate-y-0.5 ${
              currentRecording?.id === recording.id 
                ? 'border-green-500 bg-green-900/20' 
                : 'border-gray-600'
            }`}
            onClick={() => handleLoadRecording(recording)}
          >
            <div className="flex justify-between items-start mb-3">
              <h4 className="text-white text-base font-medium flex-1">{recording.name}</h4>
              <div className="flex gap-1">
                <button
                  className="text-base p-1 rounded hover:bg-green-600/10 transition-colors"
                  onClick={(e) => handleExportRecording(recording, e)}
                  title="Export as JSON"
                >
                  📤
                </button>
                <button
                  className="text-base p-1 rounded hover:bg-red-600/10 transition-colors"
                  onClick={(e) => handleDeleteRecording(recording.id, e)}
                  title="Delete recording"
                >
                  🗑️
                </button>
              </div>
            </div>
            
            <div className="mb-3 space-y-1">
              <p className="text-gray-400 text-sm">
                {formatDate(recording.createdAt)}
              </p>
              <p className="text-blue-400 text-sm">
                Duration: {formatDuration(recording.duration)}
              </p>
              <p className="text-green-400 text-sm">
                {recording.snapshots.length} snapshots
              </p>
            </div>
            
            {recording.audioBlob && (
              <div className="text-yellow-400 text-xs flex items-center gap-1">
                🎵 Has audio
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default RecordingsList;