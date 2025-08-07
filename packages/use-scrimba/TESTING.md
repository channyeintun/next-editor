# Testing use-scrimba Locally

## Method 1: Using npm link (Recommended)

### Step 1: Link the package globally

```bash
cd packages/use-scrimba
npm run build  # Make sure it's built
npm link      # Creates global symlink
```

### Step 2: Create a test React app

```bash
# Go to a different directory
cd /tmp
npx create-react-app test-use-scrimba --template typescript
cd test-use-scrimba
```

### Step 3: Link use-scrimba to the test app

```bash
npm link use-scrimba
npm install @monaco-editor/react monaco-editor
```

### Step 4: Test the basic example

Replace the contents of `src/App.tsx`:

```tsx
import React, { useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useScrimba, type Recording } from 'use-scrimba';
import './App.css';

function App() {
  const editorRef = useRef(null);
  
  const {
    // Recording state
    isRecording,
    
    // Playback state  
    isPlaying,
    currentTime,
    
    // Data
    recordings,
    currentRecording,
    
    // Recording controls
    startRecording,
    stopRecording,
    
    // Playback controls
    play,
    pause,
    stop,
    seekTo,
    
    // Recording management
    loadRecording,
    deleteRecording,
    
    // Monaco Editor integration
    handleEditorMount,
    handleEditorChange,
  } = useScrimba({
    editorRef,
    onRecordingStart: () => console.log('📹 Recording started'),
    onRecordingStop: (recording: Recording) => console.log('⏹️ Recording stopped', recording),
    onPlaybackStart: () => console.log('▶️ Playback started'),
    onPlaybackPause: () => console.log('⏸️ Playback paused'),
  });

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
    <div className="App" style={{ padding: '20px' }}>
      <h1>🎬 use-scrimba Test</h1>
      
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
          onClick={stopRecording} 
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
          defaultValue="// Test use-scrimba package!\n// Start recording and type some code\n\nconst greeting = 'Hello, use-scrimba!';\nconsole.log(greeting);\n\n// Try moving cursor, selecting text, scrolling"
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
          <p style={{ color: '#666' }}>No recordings yet. Start recording to test!</p>
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
}

export default App;
```

### Step 5: Start the test app

```bash
npm start
```

Visit http://localhost:3000 and test:
1. ✅ Start Recording
2. ✅ Type in Monaco Editor
3. ✅ Move cursor around
4. ✅ Select text
5. ✅ Scroll (if content is long enough)
6. ✅ Stop Recording
7. ✅ Play back the recording
8. ✅ Pause during playback by clicking in editor
9. ✅ Use progress bar to seek

## Method 2: Test within the monorepo

If you want to test within your existing monorepo:

### Option 1: Copy examples to your main app

```bash
# Copy the built package to node_modules
cp -r packages/use-scrimba/dist packages/use-scrimba/package.json node_modules/use-scrimba/
```

### Option 2: Use relative imports for testing

Create a test file that imports directly:

```tsx
import { useScrimba } from './packages/use-scrimba/src';
```

## Clean up after testing

```bash
# Unlink the global package
npm unlink use-scrimba -g

# In test project
npm unlink use-scrimba
```

## What to test

### ✅ Recording Functionality
- [ ] Start/stop recording works
- [ ] Editor changes are captured
- [ ] Cursor position changes are recorded
- [ ] Text selection changes are recorded
- [ ] Scroll changes are recorded (if applicable)
- [ ] Timestamps are accurate

### ✅ Playback Functionality
- [ ] Play button works
- [ ] Recorded content replays correctly
- [ ] Cursor position moves during playback
- [ ] Text selections are restored
- [ ] Scroll position is restored
- [ ] Cursor blinks during playback

### ✅ User Interaction
- [ ] Clicking during playback pauses
- [ ] Keyboard input during playback pauses
- [ ] Resume playback works after pause

### ✅ Controls
- [ ] Progress bar shows correct position
- [ ] Clicking progress bar seeks correctly
- [ ] Stop button resets everything
- [ ] Multiple recordings work

### ✅ Error Cases
- [ ] No crashes with empty recordings
- [ ] Handles editor unmounting gracefully
- [ ] No memory leaks with multiple recordings

## Expected Behavior

1. **Recording**: Should capture every keystroke, cursor movement, and selection
2. **Playback**: Should replay exactly as recorded with smooth cursor movement
3. **Pause on Interaction**: Should pause immediately when user clicks or types
4. **Seeking**: Should jump to any point in the recording accurately
5. **Multiple Recordings**: Should manage multiple sessions correctly