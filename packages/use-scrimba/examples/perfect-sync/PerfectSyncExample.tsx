import React, { useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { useScrimba, type Recording } from 'use-scrimba';

/**
 * Complete example showcasing perfect audio synchronization
 * with the independent master timeline architecture
 */
export const PerfectSyncExample: React.FC = () => {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const scrimba = useScrimba({
    editorRef,
    audioRef, // Enable perfect audio synchronization
    captureEvents: {
      content: true,
      cursorPosition: true,
      selection: true,
      scroll: true
    },
    pauseOnUserInteraction: true,
    onRecordingStart: async () => {
      console.log('🚀 Recording started with independent master timeline');
      // Start audio recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        
        audioChunksRef.current = [];
        
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        
        mediaRecorder.onstop = () => {
          stream.getTracks().forEach(track => track.stop());
        };
        
        mediaRecorder.start();
        setIsRecordingAudio(true);
        
      } catch (error) {
        console.error('❌ Failed to start audio recording:', error);
      }
    },
    onRecordingStop: (recording: Recording) => {
      console.log('⏹️ Recording stopped:', recording);
      if (mediaRecorderRef.current && isRecordingAudio) {
        mediaRecorderRef.current.stop();
        setIsRecordingAudio(false);
      }
    },
    onPlaybackStart: () => console.log('▶️ Master timeline playback started'),
    onPlaybackPause: () => console.log('⏸️ Playback paused'),
    onPlaybackUpdate: (currentTime, snapshot) => {
      // Real-time playback updates
      console.log(`⏱️ Master time: ${currentTime}ms, Snapshot: ${snapshot?.timestamp}ms`);
    },
    onStateChange: (editorState) => {
      // Editor state changes during playback
      console.log('📝 Editor state synchronized:', {
        contentLength: editorState.content.length,
        position: editorState.position,
      });
    },
  });

  const {
    isRecording,
    isPlaying,
    isPaused,
    hasEnded,
    currentTime,
    playbackSpeed,
    recordings,
    currentRecording,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    setPlaybackSpeed,
    loadRecording,
    deleteRecording,
    handleEditorMount,
    handleEditorChange,
  } = scrimba;

  // Enhanced stop recording with audio
  const handleStopRecording = () => {
    if (mediaRecorderRef.current && isRecordingAudio) {
      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stopRecording({ audioBlob });
      };
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    } else {
      stopRecording();
    }
  };

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

  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 2];

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: '30px' }}>
        <h1 style={{ color: '#1a202c', marginBottom: '10px' }}>
          🎯 Perfect Audio Synchronization Demo
        </h1>
        <p style={{ color: '#4a5568', fontSize: '16px', lineHeight: '1.5' }}>
          Experience millisecond-precise audio/code synchronization powered by independent master timeline architecture.
          No circular dependencies, no drift, perfect sync guaranteed!
        </p>
      </div>

      {/* Status Panel */}
      <div style={{ 
        marginBottom: '20px', 
        padding: '20px', 
        backgroundColor: isRecording ? '#fed7d7' : hasEnded ? '#c6f6d5' : isPlaying ? '#bee3f8' : '#f7fafc',
        borderRadius: '8px',
        border: `2px solid ${isRecording ? '#fc8181' : hasEnded ? '#48bb78' : isPlaying ? '#4299e1' : '#e2e8f0'}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <h3 style={{ margin: '0 0 5px 0', fontSize: '18px' }}>
            {isRecording ? '🔴 Recording Active' : hasEnded ? '✅ Playback Complete' : isPlaying ? '▶️ Playing' : isPaused ? '⏸️ Paused' : '⚫ Ready'}
          </h3>
          <p style={{ margin: 0, fontSize: '14px', opacity: 0.8 }}>
            {isRecording && 'Code + Audio being captured'}
            {isPlaying && `Master Timeline: ${formatTime(currentTime)} • Speed: ${playbackSpeed}x`}
            {isPaused && `Paused at ${formatTime(currentTime)}`}
            {!isRecording && !isPlaying && !isPaused && !hasEnded && 'Start recording or load a saved session'}
          </p>
        </div>
        {currentRecording && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '24px', fontWeight: 'bold' }}>
              {formatTime(currentTime)} / {formatTime(currentRecording.duration)}
            </div>
            {(currentRecording as any).audioBlob && (
              <div style={{ fontSize: '12px', color: '#48bb78', marginTop: '4px' }}>
                🎵 Perfect Audio Sync Available
              </div>
            )}
          </div>
        )}
      </div>

      {/* Hidden Audio Element */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Editor */}
      <div style={{ marginBottom: '20px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
        <Editor
          height="400px"
          language="javascript"
          theme="vs-dark"
          defaultValue={`// 🎯 Perfect Audio Synchronization Demo
// Record your voice while coding - playback will be perfectly synchronized!

class MasterTimeline {
  constructor() {
    this.startTime = performance.now();
    this.isIndependent = true;
    this.eliminatesCircularDependencies = true;
  }
  
  getCurrentTime() {
    // High-precision timing source
    return performance.now() - this.startTime;
  }
  
  synchronizeAudio(audioElement) {
    // Audio element becomes slave to master timeline
    const masterTime = this.getCurrentTime();
    audioElement.currentTime = masterTime / 1000;
  }
  
  synchronizeEditor(editor, snapshots) {
    // Editor state becomes slave to master timeline
    const masterTime = this.getCurrentTime();
    const snapshot = this.findSnapshotAt(masterTime, snapshots);
    
    if (snapshot) {
      // Direct Monaco manipulation for zero latency
      editor.setValue(snapshot.content);
      editor.setPosition(snapshot.position);
      editor.setSelection(snapshot.selection);
    }
  }
}

// 🎤 Try explaining this architecture while you code!
const timeline = new MasterTimeline();
console.log('Independent master timeline created!');`}
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
            wordWrap: 'on',
          }}
        />
      </div>

      {/* Controls */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'auto 1fr auto', 
        gap: '20px',
        alignItems: 'center',
        padding: '20px',
        backgroundColor: '#f8fafc',
        borderRadius: '8px',
        marginBottom: '20px'
      }}>
        {/* Recording Controls */}
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            onClick={startRecording} 
            disabled={isRecording}
            style={{ 
              padding: '12px 24px',
              backgroundColor: isRecording ? '#a0aec0' : '#e53e3e',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: isRecording ? 'not-allowed' : 'pointer',
              fontWeight: 'bold'
            }}
          >
            {isRecording ? '🔴 Recording...' : '🎬 Start Recording'}
          </button>
          
          <button 
            onClick={handleStopRecording} 
            disabled={!isRecording}
            style={{ 
              padding: '12px 24px',
              backgroundColor: !isRecording ? '#a0aec0' : '#38a169',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: !isRecording ? 'not-allowed' : 'pointer',
              fontWeight: 'bold'
            }}
          >
            ⏹️ Stop Recording
          </button>
        </div>

        {/* Progress Bar */}
        {currentRecording && (
          <div style={{ minWidth: '200px' }}>
            <div
              onClick={handleSeek}
              style={{
                width: '100%',
                height: '8px',
                backgroundColor: '#cbd5e0',
                borderRadius: '4px',
                cursor: 'pointer',
                position: 'relative',
                overflow: 'hidden'
              }}
            >
              <div
                style={{
                  height: '100%',
                  backgroundColor: '#4299e1',
                  width: `${(currentTime / currentRecording.duration) * 100}%`,
                  borderRadius: '4px',
                  transition: 'width 0.1s ease-out'
                }}
              />
              <div
                style={{
                  position: 'absolute',
                  top: '-6px',
                  left: `${(currentTime / currentRecording.duration) * 100}%`,
                  width: '20px',
                  height: '20px',
                  backgroundColor: '#2b6cb0',
                  borderRadius: '50%',
                  transform: 'translateX(-50%)',
                  border: '2px solid white',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                }}
              />
            </div>
          </div>
        )}

        {/* Playback Controls */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button 
            onClick={play} 
            disabled={!currentRecording || isPlaying}
            style={{ 
              padding: '10px 16px',
              backgroundColor: (!currentRecording || isPlaying) ? '#a0aec0' : '#48bb78',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: (!currentRecording || isPlaying) ? 'not-allowed' : 'pointer'
            }}
          >
            ▶️
          </button>

          <button 
            onClick={pause} 
            disabled={!isPlaying}
            style={{ 
              padding: '10px 16px',
              backgroundColor: !isPlaying ? '#a0aec0' : '#ed8936',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: !isPlaying ? 'not-allowed' : 'pointer'
            }}
          >
            ⏸️
          </button>

          <button 
            onClick={stop} 
            disabled={!currentRecording}
            style={{ 
              padding: '10px 16px',
              backgroundColor: !currentRecording ? '#a0aec0' : '#805ad5',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: !currentRecording ? 'not-allowed' : 'pointer'
            }}
          >
            ⏹️
          </button>

          {/* Speed Control */}
          <select 
            value={playbackSpeed} 
            onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
            style={{ 
              padding: '8px',
              borderRadius: '4px',
              border: '1px solid #cbd5e0',
              backgroundColor: 'white'
            }}
          >
            {speedOptions.map(speed => (
              <option key={speed} value={speed}>{speed}x</option>
            ))}
          </select>
        </div>
      </div>

      {/* Recordings Library */}
      <div>
        <h2 style={{ color: '#2d3748', marginBottom: '15px' }}>
          📚 Recordings Library ({recordings.length})
        </h2>
        {recordings.length === 0 ? (
          <div style={{ 
            padding: '40px',
            textAlign: 'center',
            backgroundColor: '#f7fafc',
            borderRadius: '8px',
            border: '2px dashed #cbd5e0'
          }}>
            <p style={{ color: '#718096', fontSize: '16px', margin: 0 }}>
              No recordings yet. Start recording to create your first perfectly synchronized session!
            </p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '12px' }}>
            {recordings.map((recording) => (
              <div
                key={recording.id}
                style={{
                  padding: '16px',
                  borderRadius: '8px',
                  border: currentRecording?.id === recording.id ? '2px solid #4299e1' : '1px solid #e2e8f0',
                  backgroundColor: currentRecording?.id === recording.id ? '#ebf8ff' : 'white'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: 'bold' }}>
                      {recording.name}
                    </h3>
                    <div style={{ display: 'flex', gap: '20px', fontSize: '14px', color: '#718096' }}>
                      <span>⏱️ {formatTime(recording.duration)}</span>
                      <span>📸 {recording.snapshots.length} snapshots</span>
                      {(recording as any).audioBlob && <span style={{ color: '#48bb78' }}>🎵 Perfect Sync</span>}
                      <span>📅 {new Date(recording.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => loadRecording(recording)}
                      style={{
                        padding: '8px 16px',
                        backgroundColor: '#4299e1',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '14px'
                      }}
                    >
                      Load
                    </button>
                    <button
                      onClick={() => deleteRecording(recording.id)}
                      style={{
                        padding: '8px 16px',
                        backgroundColor: '#e53e3e',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '14px'
                      }}
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

      {/* Architecture Info */}
      <div style={{ 
        marginTop: '30px',
        padding: '20px',
        backgroundColor: '#f0fff4',
        borderRadius: '8px',
        border: '1px solid #9ae6b4'
      }}>
        <h3 style={{ color: '#22543d', marginBottom: '15px' }}>
          🏗️ Independent Master Timeline Architecture
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', fontSize: '14px' }}>
          <div>
            <h4 style={{ color: '#2f855a', marginBottom: '8px' }}>✅ What This Solves:</h4>
            <ul style={{ color: '#276749', lineHeight: '1.6', paddingLeft: '20px' }}>
              <li>Eliminates circular audio ↔ editor dependencies</li>
              <li>Prevents timing drift accumulation</li>
              <li>Ensures millisecond-precise synchronization</li>
              <li>Robust seeking without sync loss</li>
            </ul>
          </div>
          <div>
            <h4 style={{ color: '#2f855a', marginBottom: '8px' }}>🎯 How It Works:</h4>
            <ul style={{ color: '#276749', lineHeight: '1.6', paddingLeft: '20px' }}>
              <li><code>performance.now()</code> as single source of truth</li>
              <li>Audio element synced to master timeline</li>
              <li>Editor state synced to master timeline</li>
              <li>All updates in same requestAnimationFrame</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};