import { setup, assign, spawnChild, stopChild, fromCallback, enqueueActions, fromPromise } from 'xstate';
import type * as monaco from 'monaco-editor';
import {
    createInitialContext,
    type EditorMachineContext,
    type EditorMachineEvent,
    type EditorMachineInput,
    type RecordingSession,
} from './types';
import type { EditorFrame, Recording } from '../types';
import type { Keyframe } from '../utils/deltaTypes';

/**
 * Extended model type to track file paths
 */
interface ITrackedModel extends monaco.editor.ITextModel {
    _filePath?: string;
}

/**
 * Extended window type for Monaco access
 */
interface MonacoWindow extends Window {
    monaco: typeof monaco;
}
import {
    compressFrames,
    reconstructFrameAtIndex,
    applyFrameDelta,
    findFrameIndexAtTime
} from '../utils/frameDelta';
import { timelineActor } from './timelineActor';
import { audioRecordingActor, audioPlaybackActor } from './audioActor';
import { applyContentDiff, applyPositionDiff, applySelectionDiff } from '../utils/editorDiff';
import { isValidFrameState, isEditorReady } from '../utils/validation';
import { calculateDurationFromFileReader } from '../utils/audioDuration';


// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Apply editor state from a frame
 */
const applyFrameState = (
    editor: monaco.editor.IStandaloneCodeEditor,
    frame: EditorFrame,
    cursorDecorations: string[],
    isPlaying: boolean
): string[] => {
    if (!frame.state || !isEditorReady(editor)) return cursorDecorations;

    let updatedDecorations = cursorDecorations;

    try {
        // Handle file switch if activeFile changed or model doesn't match
        const model = editor.getModel() as ITrackedModel | null;
        const currentPath = model?._filePath || '';

        if (frame.state.activeFile !== currentPath) {
            const mWindow = (window as unknown as MonacoWindow);
            let targetModel = mWindow.monaco.editor.getModels().find(m => (m as ITrackedModel)._filePath === frame.state.activeFile);

            if (!targetModel) {
                // If model doesn't exist, create it from files state
                const content = frame.state.files[frame.state.activeFile] || '';
                const extension = frame.state.activeFile.split('.').pop() || '';
                const language = extension === 'html' ? 'html' : (extension === 'css' ? 'css' : 'javascript');
                targetModel = mWindow.monaco.editor.createModel(content, language);
                (targetModel as ITrackedModel)._filePath = frame.state.activeFile;
            } else {
                // Ensure content is correct if it's a keyframe or we're seeking
                // In deltas, we rely on applyContentDiff later
                // But if the model was just switched, we might want to ensure it's up to date
                const targetContent = frame.state.files[frame.state.activeFile] || '';
                if (targetModel.getValue() !== targetContent && isPlaying) {
                    // For playback, we might need a hard set if it's far off
                    // applyContentDiff handles the minimal update
                }
            }
            editor.setModel(targetModel);
        }

        // Apply content changes to the active model
        applyContentDiff(editor, frame.state.content);

        // Apply position and selection
        if (editor.getValue() === frame.state.content) {
            applyPositionDiff(editor, frame.state.position);
            applySelectionDiff(editor, frame.state.selection);

            // Add cursor decorations during playback
            if (isPlaying) {
                const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
                const currentSelections = editor.getSelections() || [frame.state.selection];

                currentSelections.forEach((selection) => {
                    const cursorPos = selection.getPosition();
                    newDecorations.push({
                        range: new (window as unknown as MonacoWindow).monaco.Range(
                            cursorPos.lineNumber,
                            cursorPos.column,
                            cursorPos.lineNumber,
                            cursorPos.column
                        ),
                        options: {
                            className: 'playback-cursor-decoration',
                            stickiness: 1, // NeverGrowsWhenTypingAtEdges
                            minimap: {
                                color: '#007ACC',
                                position: 1, // Inline
                            },
                            overviewRuler: {
                                color: '#007ACC',
                                position: 2, // Center
                            },
                        },
                    });
                });

                updatedDecorations = editor.deltaDecorations(cursorDecorations, newDecorations);
            }

            // Restore view state (scrolling, etc.)
            if (frame.state.viewState) {
                try {
                    editor.restoreViewState(frame.state.viewState);
                } catch (err) {
                    console.error('Failed to restore view state:', err);
                }
            }
        }
    } catch (error) {
        console.error('Error applying editor state:', error);
    }

    return updatedDecorations;
};

/**
 * Create a frame from current editor state
 */
const createFrame = (
    editor: monaco.editor.IStandaloneCodeEditor,
    timestamp: number,
    mouseCursor: { x: number; y: number; visible: boolean },
    activeFile: string,
    files: Record<string, string>,
    getSlideState?: EditorMachineInput['getSlideState'],
    getPreviewState?: EditorMachineInput['getPreviewState']
): EditorFrame => {
    const content = editor.getValue();
    const selection = editor.getSelection();
    const position = editor.getPosition();
    const viewState = editor.saveViewState();
    const slideState = getSlideState?.();
    const previewState = getPreviewState?.();

    // Update the content of the active file in the files map
    const updatedFiles = { ...files, [activeFile]: content };

    return {
        timestamp,
        state: {
            activeFile,
            files: updatedFiles,
            content,
            selection: selection || {
                startLineNumber: 1,
                startColumn: 1,
                endLineNumber: 1,
                endColumn: 1,
                selectionStartLineNumber: 1,
                selectionStartColumn: 1,
                positionLineNumber: 1,
                positionColumn: 1,
            } as monaco.Selection,
            position: position || { lineNumber: 1, column: 1 } as monaco.Position,
            viewState,
            mouseCursor,
            slideState: slideState?.previewState,
            currentSlideIndex: slideState?.currentSlideIndex,
            previewState: previewState || undefined,
        },
    };
};

/**
 * Find the appropriate frame for a given timestamp (optimized)
 */

// ============================================================================
// Mouse Tracking Actor
// ============================================================================

interface MouseTrackingInput {
    onMouseMove: (pos: { x: number; y: number; visible: boolean }) => void;
}

const mouseTrackingActor = fromCallback<{ type: 'STOP' }, MouseTrackingInput>(
    ({ input }) => {
        const handleMouseMove = (e: MouseEvent) => {
            input.onMouseMove({ x: e.clientX, y: e.clientY, visible: true });
        };

        const handleMouseLeave = () => {
            input.onMouseMove({ x: 0, y: 0, visible: false });
        };

        // Handle iframe mouse tracking
        const iframeListeners = new Map<HTMLIFrameElement, { move: (e: MouseEvent) => void; leave: () => void }>();

        const setupIframeListeners = (iframe: HTMLIFrameElement) => {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                if (!iframeDoc) return;

                const onIframeMouseMove = (e: MouseEvent) => {
                    const rect = iframe.getBoundingClientRect();
                    input.onMouseMove({
                        x: rect.left + e.clientX,
                        y: rect.top + e.clientY,
                        visible: true
                    });
                };

                const onIframeMouseLeave = () => {
                    input.onMouseMove({ x: 0, y: 0, visible: false });
                };

                iframeDoc.addEventListener('mousemove', onIframeMouseMove);
                iframeDoc.addEventListener('mouseleave', onIframeMouseLeave);

                iframeListeners.set(iframe, { move: onIframeMouseMove, leave: onIframeMouseLeave });
            } catch (err) {
                // Likely cross-origin
                console.error('Cannot track mouse in iframe (cross-origin):', err);
            }
        };

        const removeIframeListeners = (iframe: HTMLIFrameElement) => {
            const handlers = iframeListeners.get(iframe);
            if (handlers) {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) {
                        iframeDoc.removeEventListener('mousemove', handlers.move);
                        iframeDoc.removeEventListener('mouseleave', handlers.leave);
                    }
                } catch (err) {
                    console.error('Error removing iframe listeners:', err);
                }
                iframeListeners.delete(iframe);
            }
        };

        // Listen for new iframes
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLIFrameElement) {
                        setupIframeListeners(node);
                    } else if (node instanceof HTMLElement) {
                        node.querySelectorAll('iframe').forEach(setupIframeListeners);
                    }
                });
                mutation.removedNodes.forEach((node) => {
                    if (node instanceof HTMLIFrameElement) {
                        removeIframeListeners(node);
                    } else if (node instanceof HTMLElement) {
                        node.querySelectorAll('iframe').forEach(removeIframeListeners);
                    }
                });
            });
        });

        observer.observe(document.body, { childList: true, subtree: true });

        // Initial setup
        document.querySelectorAll('iframe').forEach(setupIframeListeners);
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseleave', handleMouseLeave);

        return () => {
            observer.disconnect();
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseleave', handleMouseLeave);
            iframeListeners.forEach((handlers, iframe) => {
                try {
                    const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
                    if (iframeDoc) {
                        iframeDoc.removeEventListener('mousemove', handlers.move);
                        iframeDoc.removeEventListener('mouseleave', handlers.leave);
                    }
                } catch {
                    // Ignore
                }
            });
            iframeListeners.clear();
        };
    }
);

// ============================================================================
// Editor State Machine
// ============================================================================

export const editorMachine = setup({
    types: {
        context: {} as EditorMachineContext,
        events: {} as EditorMachineEvent,
        input: {} as EditorMachineInput,
    },
    actors: {
        timeline: timelineActor,
        audioRecording: audioRecordingActor,
        audioPlayback: audioPlaybackActor,
        mouseTracking: mouseTrackingActor,
        loadRecording: fromPromise<
            { recording: Recording; duration: number },
            { recording: Recording }
        >(async ({ input }) => {
            let duration = input.recording.duration;

            const audioBlob = input.recording.audioBlob;
            if (audioBlob instanceof Blob) {
                try {
                    const exactDuration = await calculateDurationFromFileReader(audioBlob);
                    // Use audio duration as the source of truth if it exists
                    // This prevents trailing silence from wall-clock overhead
                    duration = exactDuration * 1000;
                } catch (err) {
                    console.error('Failed to calculate exact audio duration:', err);
                }
            }

            return { recording: { ...input.recording, duration }, duration };
        }),
    },
    guards: {
        hasRecording: ({ context }) => context.recording !== null,
        canPlay: ({ context }) =>
            context.recording !== null &&
            (context.recording.frames?.length ?? 0) > 0,
        hasAudio: ({ context }) => context.recording?.audioBlob !== undefined,
        shouldPauseOnInteraction: ({ context }) => context.pauseOnUserInteraction,
        isValidSeekTime: ({ context, event }) => {
            if (event.type !== 'SEEK') return false;
            return event.time >= 0 && event.time <= context.timeline.duration;
        },
    },
    actions: {
        // Recording actions
        initRecordingSession: assign(() => ({
            session: {
                startedAt: Date.now(),
                activeFile: 'index.html',
                files: { 'index.html': '<html>\n    <h1>Hello world</h1>\n</html>' },
                frames: [],
                slideEvents: [],
                previewEvents: [],
                lastMousePosition: { x: 0, y: 0, visible: false },
            } as RecordingSession,
        })),

        captureInitialFrame: assign(({ context }) => {
            const editor = context.editorRefs.editor;
            const session = context.session;
            if (!session) return {};

            const lastMousePosition = session.lastMousePosition || { x: 0, y: 0, visible: false };

            const frame = editor
                ? createFrame(editor, 0, lastMousePosition, session.activeFile, session.files, context.getSlideState, context.getPreviewState)
                : {
                    timestamp: 0,
                    state: {
                        activeFile: session.activeFile,
                        files: session.files,
                        content: '',
                        selection: {
                            startLineNumber: 1,
                            startColumn: 1,
                            endLineNumber: 1,
                            endColumn: 1,
                            selectionStartLineNumber: 1,
                            selectionStartColumn: 1,
                            positionLineNumber: 1,
                            positionColumn: 1,
                        } as monaco.Selection,
                        position: { lineNumber: 1, column: 1 } as monaco.Position,
                        mouseCursor: lastMousePosition,
                    }
                } as EditorFrame;

            return {
                session: {
                    ...session,
                    frames: [frame],
                },
            };
        }),

        captureFrame: assign(({ context, event }) => {
            const editor = context.editorRefs.editor;
            if (!editor || !context.session) return {};

            const isMouseMovement = event.type === 'CAPTURE_FRAME' && event.isMouseMovement;
            const timestamp = Date.now() - context.session.startedAt;

            const mousePosition = (event.type === 'CAPTURE_FRAME' && event.mousePosition)
                ? event.mousePosition
                : context.session.lastMousePosition;

            const frame = createFrame(
                editor,
                timestamp,
                {
                    ...mousePosition,
                    visible: isMouseMovement ? true : mousePosition.visible,
                },
                context.session.activeFile,
                context.session.files,
                context.getSlideState,
                context.getPreviewState
            );

            return {
                session: {
                    ...context.session,
                    frames: [...context.session.frames, frame],
                    files: frame.state.files,
                    lastMousePosition: mousePosition,
                },
                currentFrame: frame,
            };
        }),



        finalizeRecording: assign(({ context }) => {
            if (!context.session) return { recording: null };

            // Base duration from session timing
            const duration = Math.max(Date.now() - context.session.startedAt, 1);
            const slides = context.getSlides?.();

            // Compress frames into delta frames
            const frames = compressFrames(context.session.frames);

            const recording: Recording = {
                version: 2, // New format
                id: Date.now().toString(),
                name: `Recording ${Date.now()}`,
                createdAt: Date.now(),
                frames,
                keyframeInterval: 120,
                slideEvents: context.session.slideEvents,
                previewEvents: context.session.previewEvents,
                slides: slides,
                duration,
                audioBlob: context.audio.blob || undefined,
            };

            return {
                recording,
                session: null,
                timeline: {
                    ...context.timeline,
                    duration,
                },
                lastAppliedFrameIndex: -1,
                lastAppliedPreviewEventIndex: -1,
                lastAppliedSlideEventIndex: -1,
            };
        }),

        // Playback actions
        setRecording: assign(({ context, event }) => {
            if (event.type !== 'RECORDING_LOADED') return {};

            if (event.recording.slides && context.applySlides) {
                context.applySlides(event.recording.slides);
            }

            return {
                recording: event.recording,
                timeline: {
                    currentTime: 0,
                    duration: event.duration,
                    speed: 1,
                    volume: 1,
                    startedAt: 0,
                    pausedDuration: 0,
                    pausedAt: 0,
                },
                lastAppliedFrameIndex: -1,
                lastAppliedPreviewEventIndex: -1,
                lastAppliedSlideEventIndex: -1,
            };
        }),

        updateTimelineFromTick: assign(({ context, event }) => {
            if (event.type !== 'TICK') return {};
            return {
                timeline: {
                    ...context.timeline,
                    currentTime: event.currentTime,
                },
            };
        }),

        applyFrameAtTime: assign(({ context, event }) => {
            const { recording, editorRefs, lastAppliedFrameIndex, currentFrame } = context;
            const currentTime = (event.type === 'TICK' ? event.currentTime : (event.type === 'SEEK' ? event.time : context.timeline.currentTime));

            if (!recording || !editorRefs.editor) {
                return {};
            }

            const frames = recording.frames;
            if (!frames?.length) return {};

            const frameIndex = findFrameIndexAtTime(frames, currentTime, lastAppliedFrameIndex);

            if (frameIndex === lastAppliedFrameIndex && lastAppliedFrameIndex !== -1) {
                return {};
            }

            let frame: EditorFrame | null = null;

            if (frameIndex === lastAppliedFrameIndex + 1 && currentFrame) {
                // Optimization: If it's the next frame and a delta, apply incrementally
                const deltaFrame = recording.frames[frameIndex];
                if (deltaFrame && 'isKeyframe' in deltaFrame && !deltaFrame.isKeyframe) {
                    frame = applyFrameDelta(currentFrame, deltaFrame);
                } else {
                    frame = deltaFrame as Keyframe;
                }
            } else {
                // Full reconstruction for seeks or keyframes
                frame = reconstructFrameAtIndex(recording.frames, frameIndex);
            }

            if (!frame || !frame.state || !isValidFrameState(frame.state)) {
                return { lastAppliedFrameIndex: frameIndex };
            }

            const newDecorations = applyFrameState(
                editorRefs.editor,
                frame,
                editorRefs.cursorDecorations,
                true
            );

            if (frame.state.slideState && frame.state.currentSlideIndex !== undefined && context.applySlideState) {
                context.applySlideState(frame.state.slideState, frame.state.currentSlideIndex);
            }

            let nextAppliedPreviewState = context.lastAppliedPreviewState;
            if (frame.state.previewState && context.applyPreviewState) {
                const nextState = frame.state.previewState;
                const currentState = context.lastAppliedPreviewState;

                // Only apply if state has changed significantly
                if (!currentState ||
                    nextState.size !== currentState.size ||
                    Math.abs((nextState.scrollTop || 0) - (currentState.scrollTop || 0)) > 1 ||
                    Math.abs((nextState.scrollLeft || 0) - (currentState.scrollLeft || 0)) > 1) {
                    context.applyPreviewState(nextState);
                    nextAppliedPreviewState = nextState;
                }
            }

            return {
                currentFrame: frame,
                lastAppliedFrameIndex: frameIndex,
                lastAppliedPreviewState: nextAppliedPreviewState,
                editorRefs: {
                    ...editorRefs,
                    cursorDecorations: newDecorations,
                },
            };
        }),

        seekToTime: assign(({ context, event }) => {
            if (event.type !== 'SEEK') return {};
            const clampedTime = Math.max(0, Math.min(event.time, context.timeline.duration));
            return {
                timeline: {
                    ...context.timeline,
                    currentTime: clampedTime,
                },
                lastAppliedFrameIndex: -1,
            };
        }),

        setPlaybackSpeed: assign(({ context, event }) => {
            if (event.type !== 'SET_SPEED') return {};
            return {
                timeline: {
                    ...context.timeline,
                    speed: event.speed,
                },
            };
        }),

        setVolume: assign(({ context, event }) => {
            if (event.type !== 'SET_VOLUME') return {};
            return {
                timeline: {
                    ...context.timeline,
                    volume: Math.max(0, Math.min(1, event.volume)),
                },
            };
        }),

        clearCursorDecorations: assign(({ context }) => {
            const { editorRefs } = context;
            if (editorRefs.editor && editorRefs.cursorDecorations.length > 0) {
                editorRefs.editor.deltaDecorations(editorRefs.cursorDecorations, []);
            }
            return {
                editorRefs: {
                    ...editorRefs,
                    cursorDecorations: [],
                },
            };
        }),

        resetPlayback: assign(({ context }) => ({
            timeline: {
                ...context.timeline,
                currentTime: 0,
                startedAt: 0,
                pausedDuration: 0,
                pausedAt: 0,
            },
            currentFrame: null,
            lastAppliedFrameIndex: -1,
            lastAppliedPreviewEventIndex: -1,
            lastAppliedSlideEventIndex: -1,
            lastAppliedPreviewState: undefined,
        })),

        clearRecording: assign({
            recording: null,
            currentFrame: null,
            timeline: ({ context }) => ({
                ...context.timeline,
                currentTime: 0,
                duration: 0,
            }),
        }),

        setError: assign(({ event }) => {
            if (event.type !== 'LOAD_FAILED') return {};
            return { error: event.error };
        }),

        clearError: assign({ error: null }),

        storeAudioBlob: assign(({ event }) => {
            if (event.type !== 'STOPPED') return {};
            return {
                audio: {
                    blob: event.blob,
                    element: null,
                    isRecording: false,
                    mediaRecorder: null,
                    chunks: [],
                    mimeType: event.blob.type,
                },
            };
        }),

        setEditorRef: assign(({ context, event }) => {
            if (event.type !== 'SET_EDITOR_REF') return {};
            return {
                editorRefs: {
                    ...context.editorRefs,
                    editor: event.editor,
                },
            };
        }),

        applyPreviewEventsAtTime: assign(({ context, event }) => {
            const { recording, applyPreviewState, lastAppliedPreviewEventIndex } = context;

            if (!recording?.previewEvents?.length || !applyPreviewState) {
                return {};
            }

            const previewEvents = recording.previewEvents;
            const currentTime = (event.type === 'TICK' ? event.currentTime : (event.type === 'SEEK' ? event.time : context.timeline.currentTime));
            let newLastIndex = lastAppliedPreviewEventIndex;
            let nextAppliedPreviewState = context.lastAppliedPreviewState;

            // If we've jumped backwards, reset the index to re-scan from the beginning
            if (newLastIndex >= 0 && newLastIndex < previewEvents.length) {
                if (previewEvents[newLastIndex].timestamp > currentTime) {
                    newLastIndex = -1;
                }
            }

            // Find and apply all events that should have happened by now
            let lastEventToApply = null;
            const isSeeking = event.type === 'SEEK';

            for (let i = newLastIndex + 1; i < previewEvents.length; i++) {
                const previewEvent = previewEvents[i];
                if (previewEvent.timestamp <= currentTime) {
                    if (isSeeking) {
                        // When seeking, just keep track of the last state-defining event
                        // and skip interaction events (clicks, etc.)
                        if (previewEvent.type !== 'preview_interaction') {
                            lastEventToApply = previewEvent;
                        }
                    } else {
                        // Normal playback: apply events sequentially for interactions
                        const nextState = {
                            size: previewEvent.size || 'small',
                            scrollTop: previewEvent.scrollTop,
                            scrollLeft: previewEvent.scrollLeft,
                            currentInteraction: previewEvent.interaction,
                        };

                        applyPreviewState(nextState);
                        nextAppliedPreviewState = nextState;
                    }
                    newLastIndex = i;
                } else {
                    // Events are sorted by timestamp, so stop here
                    break;
                }
            }

            // If we were seeking, apply only the final state once
            if (isSeeking && lastEventToApply) {
                const finalState = {
                    size: lastEventToApply.size || 'small',
                    scrollTop: lastEventToApply.scrollTop,
                    scrollLeft: lastEventToApply.scrollLeft,
                    // Note: interactions are skipped during seek
                };
                applyPreviewState(finalState);
                nextAppliedPreviewState = finalState;
            }

            if (newLastIndex !== lastAppliedPreviewEventIndex || nextAppliedPreviewState !== context.lastAppliedPreviewState) {
                return {
                    lastAppliedPreviewEventIndex: newLastIndex,
                    lastAppliedPreviewState: nextAppliedPreviewState
                };
            }

            return {};
        }),
        applySlideEventsAtTime: assign(({ context, event }) => {
            const { recording, applySlideState, lastAppliedSlideEventIndex } = context;

            if (!recording?.slideEvents?.length || !applySlideState) {
                return {};
            }

            const slideEvents = recording.slideEvents;
            const currentTime = (event.type === 'TICK' ? event.currentTime : (event.type === 'SEEK' ? event.time : context.timeline.currentTime));
            let newLastIndex = lastAppliedSlideEventIndex;
            const isSeeking = event.type === 'SEEK';

            // If we've jumped backwards, reset the index to re-scan from the beginning
            if (newLastIndex >= 0 && newLastIndex < slideEvents.length) {
                if (slideEvents[newLastIndex].timestamp > currentTime) {
                    newLastIndex = -1;
                }
            }

            let lastSlideEvent = null;

            // Find and apply all events that should have happened by now
            for (let i = newLastIndex + 1; i < slideEvents.length; i++) {
                const slideEvent = slideEvents[i];
                if (slideEvent.timestamp <= currentTime) {
                    if (isSeeking) {
                        // When seeking, just keep track of the last event to apply once at the end
                        lastSlideEvent = slideEvent;
                    } else {
                        // Normal playback: apply events sequentially
                        const slideIndex = recording.slides?.findIndex(s => s.id === slideEvent.slideId) ?? -1;
                        if (slideIndex !== -1 || slideEvent.type === 'slide_close') {
                            const slideState = {
                                isOpen: slideEvent.type !== 'slide_close',
                                isMaximized: !!slideEvent.isMaximized,
                                currentSlideId: slideEvent.slideId || null
                            };
                            applySlideState(slideState, slideIndex);
                        }
                    }
                    newLastIndex = i;
                } else {
                    break;
                }
            }

            // If we were seeking, apply only the final state once
            if (isSeeking && lastSlideEvent) {
                const slideIndex = (recording.slides as Array<{ id: string }> | undefined)?.findIndex(s => s.id === lastSlideEvent.slideId) ?? -1;
                if (slideIndex !== -1 || lastSlideEvent.type === 'slide_close') {
                    const slideState = {
                        isOpen: lastSlideEvent.type !== 'slide_close',
                        isMaximized: !!lastSlideEvent.isMaximized,
                        currentSlideId: lastSlideEvent.slideId || null
                    };
                    applySlideState(slideState, slideIndex);
                }
            }

            if (newLastIndex !== lastAppliedSlideEventIndex) {
                return {
                    lastAppliedSlideEventIndex: newLastIndex
                };
            }

            return {};
        }),
        switchEditorModel: ({ context }) => {
            const editor = context.editorRefs.editor;
            if (!editor) return;

            const mWindow = (window as unknown as MonacoWindow);
            let targetModel = mWindow.monaco.editor.getModels().find(m => (m as ITrackedModel)._filePath === context.activeFile);

            if (!targetModel) {
                const content = context.files[context.activeFile] || '';
                const extension = context.activeFile.split('.').pop() || '';
                const language = extension === 'html' ? 'html' : (extension === 'css' ? 'css' : 'javascript');
                targetModel = mWindow.monaco.editor.createModel(content, language);
                (targetModel as ITrackedModel)._filePath = context.activeFile;
            }
            editor.setModel(targetModel);
        },
        syncActiveFileContent: assign(({ context }) => {
            const editor = context.editorRefs.editor;
            if (!editor || !context.activeFile) return {};

            const content = editor.getValue();
            const newFiles = {
                ...context.files,
                [context.activeFile]: content,
            };

            return {
                files: newFiles,
                ...(context.session ? {
                    session: {
                        ...context.session,
                        files: {
                            ...context.session.files,
                            [context.activeFile]: content,
                        },
                    }
                } : {})
            };
        }),
    },

}).createMachine({
    id: 'editor',
    context: ({ input }) => createInitialContext(input),

    initial: 'idle',
    on: {
        SET_EDITOR_REF: {
            actions: [
                assign(({ context, event }) => {
                    if (event.type !== 'SET_EDITOR_REF') return {};
                    return {
                        editorRefs: {
                            ...context.editorRefs,
                            editor: event.editor,
                        }
                    };
                }),
                'syncActiveFileContent',
            ],
        },
        SWITCH_FILE: {
            actions: [
                'syncActiveFileContent',
                assign(({ context, event }) => {
                    if (event.type !== 'SWITCH_FILE') return {};
                    return {
                        activeFile: event.activeFile,
                        ...(context.session ? {
                            session: {
                                ...context.session,
                                activeFile: event.activeFile,
                            }
                        } : {})
                    };
                }),
                'switchEditorModel',
                'captureFrame',
            ],
        },
        ADD_FILE: {
            actions: [
                'syncActiveFileContent',
                assign(({ context, event }) => {
                    if (event.type !== 'ADD_FILE') return {};
                    const newFiles = {
                        ...context.files,
                        [event.path]: '', // New files should be empty
                    };
                    return {
                        files: newFiles,
                        ...(context.session ? {
                            session: {
                                ...context.session,
                                files: newFiles,
                            }
                        } : {})
                    };
                }),
                'captureFrame',
            ],
        },
        DELETE_FILE: {
            actions: [
                'syncActiveFileContent',
                assign(({ context, event }) => {
                    if (event.type !== 'DELETE_FILE') return {};
                    const newFiles = { ...context.files };
                    delete newFiles[event.path];
                    let activeFile = context.activeFile;
                    if (activeFile === event.path) {
                        activeFile = Object.keys(newFiles)[0] || 'index.html';
                    }
                    return {
                        files: newFiles,
                        activeFile,
                        ...(context.session ? {
                            session: {
                                ...context.session,
                                files: newFiles,
                                activeFile,
                            }
                        } : {})
                    };
                }),
                'switchEditorModel',
                'captureFrame',
            ],
        },
    },
    states: {
        idle: {
            on: {
                START_RECORDING: [
                    {
                        target: 'startingRecording',
                        guard: ({ context }) => context.enableAudioRecording,
                    },
                    {
                        target: 'recording',
                        actions: ['initRecordingSession', 'captureInitialFrame'],
                    },
                ],
                LOAD_RECORDING: 'loading',
            },
        },

        startingRecording: {
            entry: [
                enqueueActions(({ context, enqueue }) => {
                    enqueue.spawnChild('audioRecording', {
                        id: 'audioRecorder',
                        input: {
                            constraints: {
                                autoGainControl: true,
                                echoCancellation: true,
                                noiseSuppression: true,
                            }
                        }
                    });
                    enqueue.sendTo('audioRecorder', { type: 'START' });
                    enqueue.assign({
                        audio: { ...context.audio, isRecording: true }
                    });
                }),
            ],
            on: {
                STARTED: {
                    target: 'recording',
                    actions: ['initRecordingSession', 'captureInitialFrame'],
                },
                ERROR: {
                    target: 'idle',
                    actions: assign({
                        error: ({ event }) => event.type === 'ERROR' ? event.error : 'Failed to start audio'
                    }),
                },
                STOP_RECORDING: {
                    target: 'idle',
                    actions: [
                        stopChild('audioRecorder'),
                        assign({
                            audio: ({ context }) => ({ ...context.audio, isRecording: false })
                        })
                    ]
                }
            }
        },

        recording: {
            entry: [
                spawnChild('mouseTracking', {
                    id: 'mouseTracker',
                    input: ({ self }) => ({
                        onMouseMove: (pos: { x: number; y: number; visible: boolean }) => {
                            self.send({ type: 'CAPTURE_FRAME', isMouseMovement: true, mousePosition: pos });
                        },
                    }),
                }),
            ],
            exit: [],
            on: {
                CAPTURE_FRAME: {
                    actions: 'captureFrame',
                },
                STOPPED: {
                    actions: 'storeAudioBlob',
                },
                SLIDE_EVENT: {
                    actions: assign(({ context, event }) => {
                        if (!context.session) return {};
                        return {
                            session: {
                                ...context.session,
                                slideEvents: [
                                    ...context.session.slideEvents,
                                    { ...event.event, timestamp: Date.now() - context.session.startedAt },
                                ],
                            },
                        };
                    }),
                },
                PREVIEW_EVENT: {
                    actions: [
                        assign(({ context, event }) => {
                            if (!context.session) return {};
                            return {
                                session: {
                                    ...context.session,
                                    previewEvents: [
                                        ...context.session.previewEvents,
                                        { ...event.event, timestamp: Date.now() - context.session.startedAt },
                                    ],
                                },
                            };
                        }),
                        'captureFrame'
                    ],
                },
                STOP_RECORDING: [
                    {
                        target: 'stoppingRecording',
                        guard: ({ context }) => context.enableAudioRecording && context.audio.isRecording,
                    },
                    {
                        target: 'loading',
                        actions: 'finalizeRecording',
                    },
                ],
            },
        },

        stoppingRecording: {
            entry: [
                stopChild('mouseTracker'),
                enqueueActions(({ enqueue }) => {
                    enqueue.sendTo('audioRecorder', { type: 'STOP' });
                }),
            ],
            exit: [
                stopChild('audioRecorder'),
            ],
            on: {
                STOPPED: {
                    target: 'loading',
                    actions: ['storeAudioBlob', 'finalizeRecording'],
                },
            },
            after: {
                2000: {
                    target: 'loading',
                    actions: 'finalizeRecording',
                },
            },
        },

        loading: {
            invoke: {
                src: 'loadRecording',
                input: ({ context, event }) => {
                    if (event.type === 'LOAD_RECORDING') return { recording: event.recording };
                    if (context.recording) return { recording: context.recording };
                    throw new Error('No recording found to load');
                },
                onDone: {
                    target: 'playback.ready',
                    actions: [
                        assign({
                            recording: ({ event }) => event.output.recording,
                            timeline: ({ context, event }) => ({
                                ...context.timeline,
                                currentTime: 0,
                                duration: Math.max(event.output.duration, 1),
                                speed: 1,
                                volume: 1,
                                startedAt: 0,
                                pausedDuration: 0,
                                pausedAt: 0,
                            }),
                            currentFrame: null,
                        }),
                        ({ context, event }) => {
                            if (event.output.recording.slides && context.applySlides) {
                                context.applySlides(event.output.recording.slides);
                            }
                        }
                    ],
                },
                onError: {
                    target: 'idle',
                    actions: assign({
                        error: ({ event }) => event.error instanceof Error ? event.error.message : 'Failed to load recording'
                    }),
                },
            },
        },

        playback: {
            initial: 'ready',
            entry: [
                'applyFrameAtTime',
                enqueueActions(({ context, enqueue }) => {
                    enqueue.spawnChild('timeline', {
                        id: 'timelineActor',
                        input: {
                            speed: context.timeline.speed,
                            duration: context.timeline.duration,
                            startPosition: context.timeline.currentTime,
                        },
                    });

                    const audioBlob = context.recording?.audioBlob;
                    if (audioBlob instanceof Blob) {
                        enqueue.spawnChild('audioPlayback', {
                            id: 'audioPlayer',
                            input: {
                                blob: audioBlob,
                                volume: context.timeline.volume,
                                playbackRate: context.timeline.speed,
                                startPosition: context.timeline.currentTime / 1000,
                            }
                        });
                    }
                }),
            ],
            exit: [
                stopChild('timelineActor'),
                stopChild('audioPlayer'),
                'clearCursorDecorations',
            ],
            on: {
                TICK: {
                    actions: [
                        'updateTimelineFromTick',
                        'applyFrameAtTime',
                        'applyPreviewEventsAtTime',
                        'applySlideEventsAtTime',
                        enqueueActions(({ context, event, enqueue }) => {
                            // Sync audio to timeline every 250ms or on seek
                            const lastSync = context.lastSyncTime || 0;
                            const now = performance.now();
                            if (now - lastSync > 250) {
                                enqueue.sendTo('audioPlayer', { type: 'SYNC', time: event.currentTime });
                                enqueue.assign({ lastSyncTime: now });
                            }
                        })
                    ],
                },
                SEEK: {
                    actions: [
                        'seekToTime',
                        'applyFrameAtTime',
                        'applyPreviewEventsAtTime',
                        'applySlideEventsAtTime',
                        enqueueActions(({ event, enqueue }) => {
                            const time = event.type === 'SEEK' ? event.time : 0;
                            enqueue.sendTo('timelineActor', { type: 'SEEK', time });
                            enqueue.sendTo('audioPlayer', { type: 'SEEK', time: time / 1000 });
                        }),
                    ],
                },
                SET_SPEED: {
                    actions: [
                        'setPlaybackSpeed',
                        enqueueActions(({ event, enqueue }) => {
                            const speed = event.type === 'SET_SPEED' ? event.speed : 1;
                            enqueue.sendTo('timelineActor', { type: 'SET_SPEED', speed });
                            enqueue.sendTo('audioPlayer', { type: 'SET_PLAYBACK_RATE', rate: speed });
                        }),
                    ],
                },
                SET_VOLUME: {
                    actions: [
                        'setVolume',
                        enqueueActions(({ context, event, enqueue }) => {
                            if (context.recording?.audioBlob instanceof Blob) {
                                enqueue.sendTo('audioPlayer', {
                                    type: 'SET_VOLUME',
                                    volume: event.type === 'SET_VOLUME' ? event.volume : 1
                                });
                            }
                        }),
                    ],
                },
                STOP: {
                    target: '.ready',
                    actions: [
                        'resetPlayback',
                        enqueueActions(({ enqueue }) => {
                            enqueue.sendTo('timelineActor', { type: 'SEEK', time: 0 });
                            enqueue.sendTo('audioPlayer', { type: 'SEEK', time: 0 });
                        })
                    ],
                },
                UNLOAD: {
                    target: 'idle',
                    actions: 'clearRecording',
                },
            },
            states: {
                ready: {
                    on: {
                        PLAY: {
                            target: 'playing',
                            guard: 'canPlay',
                        },
                    },
                },

                playing: {
                    entry: [
                        'applyFrameAtTime',
                        'applyPreviewEventsAtTime',
                        'applySlideEventsAtTime',
                        enqueueActions(({ context, enqueue }) => {
                            enqueue.sendTo('timelineActor', { type: 'START' });
                            enqueue.sendTo('audioPlayer', { type: 'PLAY' });
                            // Ensure actors are at the machine's current time
                            enqueue.sendTo('timelineActor', { type: 'SEEK', time: context.timeline.currentTime });
                            enqueue.sendTo('audioPlayer', { type: 'SEEK', time: context.timeline.currentTime / 1000 });
                        }),
                    ],
                    exit: enqueueActions(({ enqueue }) => {
                        enqueue.sendTo('timelineActor', { type: 'PAUSE' });
                        enqueue.sendTo('audioPlayer', { type: 'PAUSE' });
                    }),
                    on: {
                        PAUSE: {
                            target: 'paused',
                        },
                        USER_INTERACTION: {
                            target: 'paused',
                            guard: 'shouldPauseOnInteraction',
                        },
                        FINISHED: {
                            target: 'ended',
                            actions: assign({
                                timeline: ({ context }) => ({
                                    ...context.timeline,
                                    currentTime: context.timeline.duration,
                                }),
                            }),
                        },
                    },
                },

                paused: {
                    on: {
                        PLAY: {
                            target: 'playing',
                        },
                    },
                },

                ended: {
                    on: {
                        PLAY: [
                            {
                                target: 'playing',
                                guard: ({ context }) => context.timeline.currentTime >= context.timeline.duration - 100, // Fuzzy end check
                                actions: [
                                    'resetPlayback',
                                    'applyFrameAtTime',
                                    'applyPreviewEventsAtTime',
                                    'applySlideEventsAtTime',
                                    enqueueActions(({ enqueue }) => {
                                        enqueue.sendTo('timelineActor', { type: 'SEEK', time: 0 });
                                        enqueue.sendTo('audioPlayer', { type: 'SEEK', time: 0 });
                                    })
                                ],
                            },
                            {
                                target: 'playing',
                            }
                        ],
                    },
                },
            },
        },

    },
});
