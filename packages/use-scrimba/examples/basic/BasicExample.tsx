/* eslint-disable @typescript-eslint/no-unused-vars, react-refresh/only-export-components */
import React, { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording } from 'use-scrimba';

const BasicExample: React.FC = () => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);

  const scrimbaHook = useScrimba({
    editorRef,
    onRecordingStart: () => console.log('📹 Recording started'),
    onRecordingStop: (recording: Recording) => {
      console.log('⏹️ Recording stopped', recording);
      setRecordings(prev => [...prev, recording]);
    },
    onPlaybackStart: () => console.log('▶️ Playback started'),
    onPlaybackPause: () => console.log('⏸️ Playback paused'),
  });

  const {
    isRecording,
    isPlaying,
    currentTime,
    // recordings removed - handled locally
    currentRecording,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    loadRecording,
    // deleteRecording removed - handled locally
    handleEditorChange,
  } = scrimbaHook;

  const formatTime = (time: number) => {
    const seconds = Math.floor(time / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${(seconds % 60).toString().padStart(2, '0')}`;
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!currentRecording) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = clickX / rect.width;
    const targetTime = percentage * currentRecording.duration;

    seekTo(targetTime);
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6 font-sans">
      <h1 className="text-2xl font-bold mb-6">Code Recorder</h1>

      <div className="bg-gray-800 rounded-lg shadow-lg overflow-hidden">
        <Editor
          height="400px"
          language="javascript"
          theme="vs-dark"
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            automaticLayout: true,
            // Disable code suggestions and IntelliSense
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            acceptSuggestionOnEnter: 'off',
            tabCompletion: 'off',
            wordBasedSuggestions: 'off',
            parameterHints: { enabled: false },
            hover: { enabled: false },
            contextmenu: false,
          }}
        />

        <div className="bg-gray-700 p-4 border-t border-gray-600">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <button
                onClick={play}
                disabled={!currentRecording || isPlaying}
                className="p-2 rounded-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Play"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
              <button
                onClick={pause}
                disabled={!isPlaying}
                className="p-2 rounded-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Pause"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
              </button>
              <button
                onClick={stop}
                disabled={!currentRecording}
                className="p-2 rounded-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Stop"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={startRecording}
                disabled={isRecording}
                className={`p-2 rounded-full ${isRecording ? 'bg-red-600 animate-pulse' : 'bg-red-500 hover:bg-red-600'} disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors`}
                title={isRecording ? 'Recording...' : 'Start Recording'}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                </svg>
              </button>
              <button
                onClick={() => stopRecording()}
                disabled={!isRecording}
                className="p-2 rounded-full bg-red-500 hover:bg-red-600 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors"
                title="Stop Recording"
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M6 6h12v12H6z" />
                </svg>
              </button>
            </div>

            {currentRecording && (
              <span className="text-sm">
                {formatTime(currentTime)} / {formatTime(currentRecording.duration)}
              </span>
            )}
          </div>

          {currentRecording && (
            <div className="mt-3">
              <div
                onClick={handleSeek}
                className="w-full h-2 bg-gray-500 rounded-full cursor-pointer relative"
              >
                <div
                  className="h-full bg-blue-500 rounded-full"
                  style={{ width: `${(currentTime / currentRecording.duration) * 100}%` }}
                >
                  <div className="absolute -right-2 -top-1.5 w-4 h-4 bg-blue-500 rounded-full border-2 border-white" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6">
        <h2 className="text-xl font-semibold mb-4">Saved Recordings ({recordings.length})</h2>
        {recordings.length === 0 ? (
          <p className="text-gray-400">No recordings yet. Start recording to create your first session!</p>
        ) : (
          <div className="grid gap-4">
            {recordings.map((recording) => (
              <div
                key={recording.id}
                className={`p-4 rounded-lg border ${currentRecording?.id === recording.id ? 'bg-blue-900/30 border-blue-500' : 'bg-gray-800 border-gray-600'}`}
              >
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="font-medium">{recording.name}</h3>
                    <p className="text-sm text-gray-400">
                      Duration: {formatTime(recording.duration)} |
                      Snapshots: {recording.snapshots.length} |
                      Created: {new Date(recording.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => loadRecording(recording)}
                      className="px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded text-sm transition-colors"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => setRecordings(prev => prev.filter(r => r.id !== recording.id))}
                      className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded text-sm transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};