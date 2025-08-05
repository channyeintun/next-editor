import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../store';
import { deleteRecording } from '../store/slices/recordingSlice';
import { loadRecording } from '../store/slices/replaySlice';

const RecordingsList: React.FC = () => {
  const dispatch = useDispatch();
  const { recordings } = useSelector((state: RootState) => state.recording);
  const { currentRecording } = useSelector((state: RootState) => state.replay);

  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (milliseconds: number): string => {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const handleLoadRecording = (recording: typeof recordings[0]) => {
    dispatch(loadRecording(recording));
  };

  const handleDeleteRecording = (id: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent loading the recording when deleting
    if (window.confirm('Are you sure you want to delete this recording?')) {
      dispatch(deleteRecording(id));
    }
  };

  if (recordings.length === 0) {
    return (
      <div>
        <h3 className="text-white text-xl font-semibold mb-4">Recordings</h3>
        <p className="text-gray-400 italic">No recordings yet. Start recording to create your first coding tutorial!</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-white text-xl font-semibold mb-5">Recordings ({recordings.length})</h3>
      
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
              <button
                className="text-base p-1 rounded hover:bg-red-600/10 transition-colors"
                onClick={(e) => handleDeleteRecording(recording.id, e)}
                title="Delete recording"
              >
                🗑️
              </button>
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