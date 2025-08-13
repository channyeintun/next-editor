#!/bin/bash

# Simplified test script that avoids Create React App issues
# Uses Vite instead for faster and more reliable setup

set -e

echo "🧪 Setting up simplified test environment for use-scrimba..."

# Get the current directory
PACKAGE_DIR=$(pwd)
TEST_DIR="/tmp/test-use-scrimba-vite-$(date +%s)"

echo "📦 Package directory: $PACKAGE_DIR"
echo "🧪 Test directory: $TEST_DIR"

# Build the package
echo "🔨 Building use-scrimba package..."
npm run build

# Link the package globally
echo "🔗 Linking package globally..."
npm link

# Create test directory
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Initialize a simple Node project
echo "📱 Creating simple test setup..."
npm init -y

# Install Vite and dependencies
echo "📦 Installing dependencies..."
npm install vite @vitejs/plugin-react typescript @types/react @types/react-dom react react-dom @monaco-editor/react monaco-editor

# Link use-scrimba
echo "🔗 Linking use-scrimba to test app..."
npm link use-scrimba

# Create directory structure
mkdir -p src public

# Create index.html
cat > index.html << 'EOF'
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>use-scrimba Test</title>
    <style>
      body { margin: 0; padding: 0; }
      
      /* Scrimba cursor styles */
      .PointerView > .pointer-body {
        position: absolute;
        transition: opacity .1s ease-out;
        opacity: .99;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
EOF

# Create vite.config.ts
cat > vite.config.ts << 'EOF'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000
  }
})
EOF

# Create tsconfig.json
cat > tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
EOF

# Create tsconfig.node.json
cat > tsconfig.node.json << 'EOF'
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
EOF

# Create main.tsx
cat > src/main.tsx << 'EOF'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
EOF

# Create the test App.tsx with video player layout and cursor functionality
cat > src/App.tsx << 'EOF'
import React, { useRef } from 'react';
import Editor from '@monaco-editor/react';
import { useScrimba, type Recording, type MouseCursorPosition } from 'use-scrimba';

// Fake cursor component for playback
interface FakeCursorProps {
  position: MouseCursorPosition;
}

const FakeCursor: React.FC<FakeCursorProps> = ({ position }) => {
  if (!position.visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        width: 24,
        height: 24,
        pointerEvents: 'none',
        zIndex: 9999,
        transform: 'translate(0, 0)',
      }}
    >
      {/* Cursor icon using Unicode arrow */}
      <svg 
        width="24" 
        height="24" 
        viewBox="0 0 24 24" 
        fill="none" 
        style={{ 
          filter: 'drop-shadow(1px 1px 2px rgba(0,0,0,0.5))'
        }}
      >
        <path 
          d="M3 3L10.07 19.97L12.58 12.58L19.97 10.07L3 3Z" 
          fill="white" 
          stroke="black" 
          strokeWidth="1"
        />
      </svg>
    </div>
  );
};

function App() {
  const editorRef = useRef(null);
  const [recordings, setRecordings] = React.useState<Recording[]>([]);
  
  const {
    isRecording,
    isPlaying,
    currentTime,
    currentRecording,
    currentCursor,
    startRecording,
    stopRecording,
    play,
    pause,
    stop,
    seekTo,
    loadRecording,
    handleEditorChange,
  } = useScrimba({
    editorRef,
    onRecordingStop: (recording) => {
      // Save recording to local state
      setRecordings(prev => [...prev, recording]);
      console.log('Recording saved:', recording);
    },
    onStateChange: (state) => {
      // You can access mouse cursor data here
      if (isRecording) {
        console.log('Recording state change:', {
          hasMouseCursor: !!state.mouseCursor,
          mouseCursor: state.mouseCursor,
          content: state.content.substring(0, 50) + '...'
        });
      }
    },
  });

  // Helper functions for recording management
  const handleLoadRecording = (recording: Recording) => {
    loadRecording(recording);
  };

  const handleDeleteRecording = (recordingId: string) => {
    setRecordings(prev => prev.filter(r => r.id !== recordingId));
    if (currentRecording?.id === recordingId) {
      stop();
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

  const controlButtonStyle = (disabled: boolean, active = false) => ({
    width: '48px',
    height: '48px',
    borderRadius: '50%',
    border: 'none',
    backgroundColor: disabled ? '#666' : active ? '#ff4444' : '#007acc',
    color: 'white',
    fontSize: '18px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 8px',
    transition: 'all 0.2s ease',
  });

  const smallButtonStyle = {
    padding: '8px 12px',
    borderRadius: '4px',
    border: 'none',
    backgroundColor: '#007acc',
    color: 'white',
    fontSize: '12px',
    cursor: 'pointer',
    margin: '0 4px',
  };

  return (
    <>
      {/* Fake Cursor - Fixed to viewport during playback */}
      {isPlaying && currentCursor && currentCursor.visible && (
        <FakeCursor position={currentCursor} />
      )}

      <div style={{ 
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'Arial, sans-serif',
        backgroundColor: '#1e1e1e'
      }}>
        
        {/* Main Video/Editor Area */}
      <div style={{ flex: 1, padding: '20px', paddingBottom: '10px', position: 'relative' }}>
        <Editor
          height="100%"
          language="javascript"
          theme="vs-dark"
          defaultValue={`// 🎬 Scrimba-like Recording Demo with Mouse Cursor
// 1. Click the red record button below
// 2. Type, move your mouse around, select text
// 3. Stop recording and play it back!
// 4. Watch the red cursor follow your recorded movements!

function createAwesome() {
  const features = [
    'Real-time recording',
    'Mouse cursor tracking', 
    'Text caret position tracking',
    'Text selection replay',
    'Smooth playback with cursor'
  ];
  
  return features.map(f => \`✨ \${f}\`);
}

createAwesome();

// Move your mouse around while recording
// The red cursor will replay your movements!`}
          onMount={(editor) => { 
            editorRef.current = editor;
          }}
          onChange={handleEditorChange}
          options={{
            minimap: { enabled: false },
            fontSize: 16,
            lineNumbers: 'on',
            automaticLayout: true,
            wordWrap: 'on',
            scrollBeyondLastLine: false,
          }}
        />
        
      </div>

      {/* Video Player Controls */}
      <div style={{ 
        backgroundColor: '#2d2d2d',
        borderTop: '1px solid #444',
        padding: '16px 20px'
      }}>
        
        {/* Progress Bar */}
        {currentRecording && (
          <div style={{ marginBottom: '16px' }}>
            <div 
              onClick={handleSeek}
              style={{ 
                width: '100%', 
                height: '8px', 
                backgroundColor: '#444',
                cursor: 'pointer',
                borderRadius: '4px',
                overflow: 'hidden',
                position: 'relative' as const
              }}
            >
              <div 
                style={{
                  width: `${Math.min((currentTime / currentRecording.duration) * 100, 100)}%`,
                  height: '100%',
                  backgroundColor: '#ff4444'
                }}
              />
              <div style={{
                position: 'absolute',
                top: '50%',
                left: `${Math.min((currentTime / currentRecording.duration) * 100, 100)}%`,
                width: '16px',
                height: '16px',
                backgroundColor: '#ff4444',
                borderRadius: '50%',
                transform: 'translate(-50%, -50%)',
                border: '2px solid white',
                boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
              }} />
            </div>
          </div>
        )}

        {/* Controls Row */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between'
        }}>
          
          {/* Left: Main Controls */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {!isRecording ? (
              <>
                <button 
                  onClick={startRecording}
                  style={controlButtonStyle(false, false)}
                  title="Start Recording"
                >
                  🔴
                </button>
                {currentRecording && (
                  <>
                    <button 
                      onClick={isPlaying ? pause : play}
                      disabled={!currentRecording}
                      style={controlButtonStyle(!currentRecording)}
                      title={isPlaying ? "Pause" : "Play"}
                    >
                      {isPlaying ? '⏸️' : '▶️'}
                    </button>
                    <button 
                      onClick={stop}
                      disabled={!currentRecording}
                      style={controlButtonStyle(!currentRecording)}
                      title="Stop"
                    >
                      ⏹️
                    </button>
                  </>
                )}
              </>
            ) : (
              <button 
                onClick={stopRecording}
                style={controlButtonStyle(false, true)}
                title="Stop Recording"
              >
                ⏹️
              </button>
            )}
            
            {/* Time Display */}
            <div style={{ 
              color: 'white', 
              fontSize: '14px', 
              marginLeft: '20px',
              fontFamily: 'monospace'
            }}>
              {currentRecording ? (
                `${formatTime(currentTime)} / ${formatTime(currentRecording.duration)}`
              ) : isRecording ? (
                '🔴 REC'
              ) : (
                '⏸️ Ready'
              )}
            </div>
            
            {/* Mouse Cursor Info During Playback */}
            {isPlaying && currentCursor && (
              <div style={{ 
                color: '#ff4444', 
                fontSize: '12px', 
                marginLeft: '16px',
                fontFamily: 'monospace'
              }}>
                🖱️ ({Math.round(currentCursor.x)}, {Math.round(currentCursor.y)})
              </div>
            )}
          </div>

          {/* Right: Recording List */}
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ color: '#ccc', fontSize: '14px', marginRight: '12px' }}>
              {recordings.length} recording{recordings.length !== 1 ? 's' : ''}
            </span>
            
            {recordings.length > 0 && (
              <select
                value={currentRecording?.id || ''}
                onChange={(e) => {
                  const recording = recordings.find(r => r.id === e.target.value);
                  if (recording) handleLoadRecording(recording);
                }}
                style={{
                  backgroundColor: '#444',
                  color: 'white',
                  border: '1px solid #666',
                  borderRadius: '4px',
                  padding: '6px 12px',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                <option value="">Select recording...</option>
                {recordings.map((recording) => (
                  <option key={recording.id} value={recording.id}>
                    {recording.name} ({formatTime(recording.duration)})
                  </option>
                ))}
              </select>
            )}
            
            {currentRecording && (
              <button 
                onClick={() => handleDeleteRecording(currentRecording.id)}
                style={{
                  ...smallButtonStyle,
                  backgroundColor: '#ff4444',
                  marginLeft: '8px'
                }}
                title="Delete current recording"
              >
                🗑️
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}

export default App;
EOF

# Add scripts to package.json
echo "📝 Adding scripts..."
cat > package.json << EOF
{
  "name": "use-scrimba-test",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "@monaco-editor/react": "^4.6.0",
    "monaco-editor": "^0.47.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.56",
    "@types/react-dom": "^18.2.19",
    "@vitejs/plugin-react": "^4.2.1",
    "typescript": "^5.2.2",
    "vite": "^5.1.4"
  }
}
EOF

echo ""
echo "✅ Video player-style test environment setup complete!"
echo ""
echo "📝 Starting development server..."
echo "   🌐 Opening browser at http://localhost:3000"
echo "   📁 Test directory: $TEST_DIR"
echo ""
echo "🧹 To clean up after testing:"
echo "   rm -rf $TEST_DIR"
echo "   npm unlink use-scrimba -g"
echo ""

# Start the development server
npm run dev