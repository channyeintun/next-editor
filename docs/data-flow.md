# Data Flow Documentation

This document describes the data flow patterns in the Next Editor application.

---

## High-Level Architecture

```mermaid
flowchart TB
    subgraph UI["UI Layer"]
        Editor[Monaco Editor]
        Controls[Media Controls]
        Preview[Preview Panel]
        Slides[Slides Panel]
    end

    subgraph Context["React Context Layer"]
        NAC[NextEditorActionsContext]
        NMC[NextEditorMetadataContext]
        NPC[NextEditorPlaybackContext]
        SC[SlidesContext]
    end

    subgraph Core["Core Layer"]
        Hook[useNextEditor Hook]
        Machine[XState Editor Machine]
    end

    subgraph Actors["Child Actors"]
        Timeline[Timeline Actor]
        AudioRec[Audio Recording Actor]
        AudioPlay[Audio Playback Actor]
        Mouse[Mouse Tracking Actor]
    end

    subgraph Storage["Storage Layer"]
        JsonStorage[JsonStorage]
        LocalStorage[(localStorage)]
        FileSystem[(File System)]
    end

    Editor <--> NAC
    Controls <--> NAC
    Preview <--> NAC
    Slides <--> SC

    NAC --> Hook
    NMC --> Hook
    NPC --> Hook
    SC --> NAC

    Hook --> Machine
    Machine --> Timeline
    Machine --> AudioRec
    Machine --> AudioPlay
    Machine --> Mouse

    NAC --> JsonStorage
    JsonStorage --> LocalStorage
    JsonStorage --> FileSystem
```

---

## Recording Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as UI Components
    participant Context as NextEditorContext
    participant Machine as EditorMachine
    participant Audio as AudioActor
    participant Mouse as MouseActor

    User->>UI: Click Start Recording
    UI->>Context: startRecording()
    Context->>Machine: START_RECORDING event

    alt Audio Recording Enabled
        Machine->>Machine: Enter startingRecording
        Machine->>Audio: Spawn audioRecording actor
        Machine->>Audio: START event
        Audio-->>Machine: STARTED event
    end

    Machine->>Machine: Enter recording state
    Machine->>Mouse: Spawn mouseTracking actor
    Machine->>Machine: initRecordingSession
    Machine->>Machine: captureInitialFrame

    loop During Recording
        User->>UI: Type in Editor
        UI->>Context: handleEditorChange()
        Context->>Machine: CAPTURE_FRAME event
        Machine->>Machine: captureFrame action

        Mouse-->>Machine: Mouse movement
        Machine->>Machine: CAPTURE_FRAME with position

        opt Slide Event
            UI->>Context: handleSlideEvent()
            Context->>Machine: SLIDE_EVENT
            Machine->>Machine: Record slide event
        end

        opt Preview Event
            UI->>Context: handlePreviewEvent()
            Context->>Machine: PREVIEW_EVENT
            Machine->>Machine: Record preview state + event
        end

        opt Workspace Changes (v3)
            Runtime-->>Machine: File/folder change
            Context->>Machine: WORKSPACE_EVENT
            Machine->>Machine: Record workspace event
        end

        opt Runtime Events (v3)
            Runtime-->>Machine: Terminal/process output
            Context->>Machine: RUNTIME_EVENT
            Machine->>Machine: Record runtime event
        end
    end

    User->>UI: Click Stop Recording
    UI->>Context: stopRecording()
    Context->>Machine: STOP_RECORDING event

    alt Audio Recording Active
        Machine->>Machine: Enter stoppingRecording
        Machine->>Audio: STOP event
        Audio-->>Machine: STOPPED with Blob
        Machine->>Machine: storeAudioBlob
    end

    Machine->>Machine: finalizeRecording
    Machine->>Machine: compressFrames (delta compression)
    Machine->>Machine: Enter loading state
    Machine->>Machine: Load recording for playback
```

---

## Playback Flow

```mermaid
sequenceDiagram
    participant User
    participant UI as UI Components
    participant Context as NextEditorContext
    participant Machine as EditorMachine
    participant Timeline as TimelineActor
    participant Audio as AudioPlaybackActor
    participant Editor as Monaco Editor

    User->>UI: Load Recording
    UI->>Context: loadRecording(recording)
    Context->>Machine: LOAD_RECORDING event
    Machine->>Machine: Enter loading state
    Machine->>Machine: Calculate audio duration
    Machine->>Machine: Enter playback.ready

    Machine->>Timeline: Spawn timeline actor
    Machine->>Audio: Spawn audio playback actor

    User->>UI: Click Play
    UI->>Context: play()
    Context->>Machine: PLAY event
    Machine->>Machine: Enter playback.playing
    Machine->>Timeline: START event
    Machine->>Audio: PLAY event

    loop Animation Frame Loop
        Timeline-->>Machine: TICK event (currentTime)
        Machine->>Machine: updateTimelineFromTick
        Machine->>Machine: applyFrameAtTime
        Machine->>Editor: Apply content changes
        Machine->>Editor: Apply selection/position
        Machine->>Editor: Apply decorations
        Machine->>Machine: applyPreviewEventsAtTime
        Machine->>Machine: applySlideEventsAtTime
        Machine->>Machine: applyWorkspaceEventsAtTime (v3)
        Machine->>Machine: applyRuntimeEventsAtTime (v3)

        opt Audio Sync (every 250ms)
            Machine->>Audio: SYNC event
        end

        opt Preview State Update
            Machine->>Machine: Restore preview state at checkpoint
        end
    end

    alt User Pauses
        User->>UI: Click Pause / Press Space
        UI->>Context: pause()
        Context->>Machine: PAUSE / USER_INTERACTION
        Machine->>Machine: Enter playback.paused
        Machine->>Timeline: PAUSE event
        Machine->>Audio: PAUSE event
    end

    alt Playback Ends
        Timeline-->>Machine: FINISHED event
        Machine->>Machine: Enter playback.ended
    end
```

---

## Storage Flow

```mermaid
flowchart TB
    subgraph Export["Export Flow"]
        R1[Recording] --> E1[Extract Audio Data]
        E1 --> E2[Replace with Placeholders]
        E2 --> E3[SuperJSON Serialize]
        E3 --> E4[Pako Compress]
        E4 --> E5[Create Binary Header]
        E5 --> E6[Concatenate Audio Data]
        E6 --> E7[Base64 Encode]
        E7 --> E8[Save to File/localStorage]
    end

    subgraph Import["Import Flow"]
        I1[Read File/localStorage] --> I2[Base64 Decode]
        I2 --> I3[Parse Binary Header]
        I3 --> I4[Extract Compressed JSON]
        I4 --> I5[Pako Inflate]
        I5 --> I6[SuperJSON Parse]
        I6 --> I7[Extract Audio Data]
        I7 --> I8[Reconstruct Blobs]
        I8 --> I9[Recording]
    end
```

### Binary File Format

```
┌─────────────────────────────────────────┐
│ Magic Number: "SCRM" (4 bytes)          │
├─────────────────────────────────────────┤
│ Version: 2 (2 bytes, Uint16)            │
├─────────────────────────────────────────┤
│ JSON Length (4 bytes, Uint32)           │
├─────────────────────────────────────────┤
│ Compressed JSON Data                    │
│ (variable length, deflate compressed)   │
├─────────────────────────────────────────┤
│ Audio Data                              │
│ (raw binary, concatenated)              │
└─────────────────────────────────────────┘
```

---

## Context Data Flow

```mermaid
flowchart LR
    subgraph Provider["NextEditorProvider"]
        direction TB
        Hook[useNextEditor Hook]

        subgraph Contexts["Split Contexts"]
            Actions["Actions Context<br/>(Stable Functions)"]
            Metadata["Metadata Context<br/>(State Flags)"]
            Playback["Playback Context<br/>(High Frequency)"]
        end

        Hook --> Actions
        Hook --> Metadata
        Hook --> Playback
    end

    subgraph Consumers["Consumer Components"]
        RC[RecordingControls]
        MC[MediaControls]
        CP[CursorPlayer]
        ED[Editor]
    end

    Actions --> RC
    Actions --> MC
    Actions --> ED
    Metadata --> RC
    Metadata --> MC
    Playback --> MC
    Playback --> CP
```

This context splitting pattern prevents unnecessary re-renders:

- **Actions Context**: Stable function references, rarely changes
- **Metadata Context**: Recording state flags, changes on state transitions
- **Playback Context**: Current time and cursor, updates every animation frame

---

## Frame Application Flow

```mermaid
flowchart TB
    Start([TICK Event]) --> FindIndex[Find frame at currentTime]
    FindIndex --> CheckIndex{Same as<br/>lastAppliedIndex?}

    CheckIndex -->|Yes| Skip[Skip - no changes]
    CheckIndex -->|No| CheckDelta{Is next frame<br/>a delta?}

    CheckDelta -->|Yes| ApplyDelta[Apply delta to current frame]
    CheckDelta -->|No| Reconstruct[Full reconstruction from keyframe]

    ApplyDelta --> Validate{Valid frame state?}
    Reconstruct --> Validate

    Validate -->|No| UpdateIndex[Update lastAppliedIndex only]
    Validate -->|Yes| ApplyContent[Apply content to editor]

    ApplyContent --> ApplySelection[Apply selection/position]
    ApplySelection --> ApplyView[Apply view state]
    ApplyView --> ApplyDecorations[Apply cursor decorations]
    ApplyDecorations --> ApplySlides[Apply slide state]
    ApplySlides --> ApplyPreview[Apply preview state]
    ApplyPreview --> Done([Frame Applied])
```
