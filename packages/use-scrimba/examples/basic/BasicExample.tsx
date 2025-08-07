import React, { useRef } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording } from 'use-scrimba';

/**
 * Basic example demonstrating core useScrimba functionality
 */
export const BasicExample: React.FC = () => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  
  const scrimbaHook = useScrimba({
    editorRef,
    onRecordingStart: () => console.log('📹 Recording started'),
    onRecordingStop: (recording: Recording) => console.log('⏹️ Recording stopped', recording),
    onPlaybackStart: () => console.log('▶️ Playback started'),
    onPlaybackPause: () => console.log('⏸️ Playback paused'),
  });

  // Destructure with explicit typing
  const {
    isRecording,
    isPlaying,
    currentTime,
    recordings,
    currentRecording,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    loadRecording,
    deleteRecording,
    handleEditorMount,
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
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>🎬 useScrimba Basic Example</h1>
      
      {/* Recording Controls */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Recording Controls</h2>
        <button 
          onClick={startRecording} 
          disabled={isRecording}
          style={{ marginRight: '10px', padding: '8px 16px' }}
        >
          {isRecording ? '🔴 Recording...' : '📹 Start Recording'}
        </button>
        <button 
          onClick={() => stopRecording()} 
          disabled={!isRecording}
          style={{ padding: '8px 16px' }}
        >
          ⏹️ Stop Recording
        </button>
      </div>

      {/* Playback Controls */}
      <div style={{ marginBottom: '20px' }}>
        <h2>Playback Controls</h2>
        <button 
          onClick={play} 
          disabled={!currentRecording || isPlaying}
          style={{ marginRight: '10px', padding: '8px 16px' }}
        >
          ▶️ Play
        </button>
        <button 
          onClick={pause} 
          disabled={!isPlaying}
          style={{ marginRight: '10px', padding: '8px 16px' }}
        >
          ⏸️ Pause
        </button>
        <button 
          onClick={stop} 
          disabled={!currentRecording}
          style={{ marginRight: '10px', padding: '8px 16px' }}
        >
          ⏹️ Stop
        </button>
        
        {currentRecording && (
          <span style={{ marginLeft: '20px' }}>
            {formatTime(currentTime)} / {formatTime(currentRecording.duration)}
          </span>
        )}
      </div>

      {/* Progress Bar */}
      {currentRecording && (
        <div style={{ marginBottom: '20px' }}>
          <div 
            onClick={handleSeek}
            style={{ 
              width: '100%', 
              height: '8px', 
              backgroundColor: '#ddd',
              cursor: 'pointer',
              borderRadius: '4px',
              overflow: 'hidden'
            }}
          >
            <div 
              style={{
                width: `${(currentTime / currentRecording.duration) * 100}%`,
                height: '100%',
                backgroundColor: '#007acc',
                transition: 'width 0.1s'
              }}
            />
          </div>
        </div>
      )}

      {/* Monaco Editor */}
      <div style={{ marginBottom: '20px' }}>
        <Editor
          height="400px"
          language="javascript"
          theme="vs-dark"
          defaultValue="// Start typing to record your coding session!\n// Click to pause during playback\n\nconst greeting = 'Hello, useScrimba!';\nconsole.log(greeting);"
          onMount={(editor) => { 
            editorRef.current = editor; 
            handleEditorMount(editor); 
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            lineNumbers: 'on',
            automaticLayout: true,
          }}
        />
      </div>

      {/* Recordings List */}
      <div>
        <h2>Saved Recordings ({recordings.length})</h2>
        {recordings.length === 0 ? (
          <p style={{ color: '#666' }}>No recordings yet. Start recording to create your first session!</p>
        ) : (
          <div style={{ display: 'grid', gap: '10px' }}>
            {recordings.map((recording) => (
              <div 
                key={recording.id}
                style={{ 
                  padding: '15px', 
                  border: '1px solid #ddd', 
                  borderRadius: '8px',
                  backgroundColor: currentRecording?.id === recording.id ? '#f0f8ff' : '#fff'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: '0 0 5px 0' }}>{recording.name}</h3>
                    <p style={{ margin: '0', color: '#666', fontSize: '14px' }}>
                      Duration: {formatTime(recording.duration)} | 
                      Snapshots: {recording.snapshots.length} | 
                      Created: {new Date(recording.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <button 
                      onClick={() => loadRecording(recording)}
                      style={{ marginRight: '10px', padding: '6px 12px' }}
                    >
                      📂 Load
                    </button>
                    <button 
                      onClick={() => deleteRecording(recording.id)}
                      style={{ padding: '6px 12px', backgroundColor: '#ff4444', color: 'white', border: 'none', borderRadius: '4px' }}
                    >
                      🗑️ Delete
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