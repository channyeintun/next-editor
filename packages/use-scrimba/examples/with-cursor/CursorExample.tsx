import React, { useRef, useEffect, useState } from 'react';
import { Editor } from '@monaco-editor/react';
import { useScrimba } from '../../src';
import type { MouseCursorPosition } from '../../src/types';

interface FakeCursorProps {
  position: MouseCursorPosition;
}

const FakeCursor: React.FC<FakeCursorProps> = ({ position }) => {
  if (!position.visible) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: position.x - 5, // Center the cursor
        top: position.y - 5,
        width: 10,
        height: 10,
        borderRadius: '50%',
        backgroundColor: 'red',
        pointerEvents: 'none',
        zIndex: 1000,
        transition: 'left 0.1s ease, top 0.1s ease',
      }}
    />
  );
};

export const CursorExample: React.FC = () => {
  const editorRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);

  const scrimba = useScrimba({
    editorRef,
    audioRef,
    onRecordingStop: (recording) => {
      console.log('Recording stopped:', recording);
    },
    onStateChange: (state) => {
      console.log('Editor state changed:', state);
      // Access mouse cursor position here:
      if (state.mouseCursor) {
        console.log('Mouse cursor at:', state.mouseCursor);
      }
    },
  });

  // Audio recording setup
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        recorder.ondataavailable = (event) => {
          chunks.push(event.data);
        };

        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          setAudioBlob(blob);
          scrimba.stopRecording({ audioBlob: blob });
        };

        setMediaRecorder(recorder);
      })
      .catch(console.error);
  }, []);

  const handleRecord = () => {
    if (!scrimba.isRecording) {
      scrimba.startRecording();
      mediaRecorder?.start();
    } else {
      mediaRecorder?.stop();
    }
  };

  const handlePlay = () => {
    if (scrimba.isPlaying) {
      scrimba.pause();
    } else {
      scrimba.play();
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '10px' }}>
        <button onClick={handleRecord}>
          {scrimba.isRecording ? 'Stop Recording' : 'Start Recording'}
        </button>
        <button onClick={handlePlay} disabled={!scrimba.currentRecording}>
          {scrimba.isPlaying ? 'Pause' : 'Play'}
        </button>
        <button onClick={scrimba.stop} disabled={!scrimba.currentRecording}>
          Stop
        </button>
      </div>

      <div style={{ position: 'relative', flex: 1 }}>
        <Editor
          height="100%"
          defaultLanguage="typescript"
          defaultValue="// Start recording and move your mouse around the editor!"
          onMount={(editor) => {
            editorRef.current = editor;
          }}
          onChange={() => scrimba.handleEditorChange()}
        />

        {/* Fake Cursor Display During Playback */}
        {scrimba.isPlaying && scrimba.currentSnapshot?.state?.mouseCursor && (
          <FakeCursor position={scrimba.currentSnapshot.state.mouseCursor} />
        )}
      </div>

      <audio ref={audioRef} />

      <div style={{ padding: '10px', fontSize: '12px', color: '#666' }}>
        <div>Recording: {scrimba.isRecording ? 'YES' : 'NO'}</div>
        <div>Playing: {scrimba.isPlaying ? 'YES' : 'NO'}</div>
        <div>Current Time: {Math.round(scrimba.currentTime)}ms</div>
        {scrimba.currentSnapshot?.state?.mouseCursor && (
          <div>
            Mouse: {scrimba.currentSnapshot.state.mouseCursor.visible ? 'VISIBLE' : 'HIDDEN'} 
            at ({scrimba.currentSnapshot.state.mouseCursor.x}, {scrimba.currentSnapshot.state.mouseCursor.y})
          </div>
        )}
      </div>
    </div>
  );
};