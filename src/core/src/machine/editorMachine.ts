import { setup, assign, spawnChild, stopChild, fromCallback, enqueueActions, fromPromise } from 'xstate';
import type * as monaco from 'monaco-editor';
import type {
    EditorMachineContext,
    EditorMachineEvent,
    EditorMachineInput,
    RecordingSession,
} from './types';
import type { EditorSnapshot, Recording } from '../types';
import { timelineActor } from './timelineActor';
import { audioRecordingActor, audioPlaybackActor } from './audioActor';
import { applyContentDiff, applyPositionDiff, applySelectionDiff } from '../utils/editorDiff';
import { isValidSnapshotState, isEditorReady } from '../utils/validation';
import { calculateDurationFromFileReader } from '../utils/audioDuration';


// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Apply editor state from a snapshot
 */
const applyEditorState = (
    editor: monaco.editor.IStandaloneCodeEditor,
    snapshot: EditorSnapshot,
    cursorDecorations: string[],
    isPlaying: boolean
): string[] => {
    if (!snapshot.state || !isEditorReady(editor)) return cursorDecorations;

    let updatedDecorations = cursorDecorations;

    try {
        // Apply content changes
        applyContentDiff(editor, snapshot.state.content);

        // Apply position and selection
        if (editor.getValue() === snapshot.state.content) {
            applyPositionDiff(editor, snapshot.state.position);
            applySelectionDiff(editor, snapshot.state.selection);

            // Add cursor decorations during playback
            if (isPlaying) {
                const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];
                const currentSelections = editor.getSelections() || [snapshot.state.selection];

                currentSelections.forEach((selection) => {
                    const cursorPos = selection.getPosition();
                    newDecorations.push({
                        range: new (window as unknown as { monaco: typeof monaco }).monaco.Range(
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
            if (snapshot.state.viewState) {
                try {
                    editor.restoreViewState(snapshot.state.viewState);
                } catch (err) {
                    console.warn('Failed to restore view state:', err);
                }
            }
        }
    } catch (error) {
        console.warn('Error applying editor state:', error);
    }

    return updatedDecorations;
};

/**
 * Create a snapshot from current editor state
 */
const createSnapshot = (
    editor: monaco.editor.IStandaloneCodeEditor,
    timestamp: number,
    mouseCursor: { x: number; y: number; visible: boolean },
    getSlideState?: EditorMachineInput['getSlideState'],
    getPreviewState?: EditorMachineInput['getPreviewState']
): EditorSnapshot => {
    const content = editor.getValue();
    const selection = editor.getSelection();
    const position = editor.getPosition();
    const viewState = editor.saveViewState();
    const slideState = getSlideState?.();
    const previewState = getPreviewState?.();

    return {
        timestamp,
        state: {
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
 * Find the appropriate snapshot for a given timestamp (optimized)
 */
const findSnapshotIndexAtTime = (
    snapshots: EditorSnapshot[],
    time: number,
    startIndex: number = 0
): number => {
    if (!snapshots.length) return -1;

    // Fast path: try starting from previous index
    let index = Math.max(0, startIndex);

    // If we've jumped back, search from the beginning
    if (snapshots[index].timestamp > time) {
        index = 0;
    }

    // Linear search forward (efficient for incremental ticks)
    let bestIndex = index;
    for (let i = index; i < snapshots.length; i++) {
        if (snapshots[i].timestamp <= time) {
            bestIndex = i;
        } else {
            break;
        }
    }

    return bestIndex;
};

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
                console.warn('Cannot track mouse in iframe (cross-origin):', err);
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
                    console.warn('Failed to calculate exact audio duration:', err);
                }
            }

            return { recording: { ...input.recording, duration }, duration };
        }),
    },
    guards: {
        hasRecording: ({ context }) => context.recording !== null,
        canPlay: ({ context }) =>
            context.recording !== null &&
            context.recording.snapshots.length > 0,
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
                snapshots: [],
                slideEvents: [],
                previewEvents: [],
                lastMousePosition: { x: 0, y: 0, visible: false },
            } as RecordingSession,
        })),

        captureInitialSnapshot: assign(({ context }) => {
            const editor = context.editorRefs.editor;
            const session = context.session;
            if (!session) return {};

            const lastMousePosition = session.lastMousePosition || { x: 0, y: 0, visible: false };

            const snapshot = editor
                ? createSnapshot(editor, 0, lastMousePosition, context.getSlideState, context.getPreviewState)
                : {
                    timestamp: 0,
                    state: {
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
                } as EditorSnapshot;

            return {
                session: {
                    ...session,
                    snapshots: [snapshot],
                },
            };
        }),

        captureSnapshot: assign(({ context, event }) => {
            const editor = context.editorRefs.editor;
            if (!editor || !context.session) return {};

            const isMouseMovement = event.type === 'CAPTURE_SNAPSHOT' && event.isMouseMovement;
            const timestamp = Date.now() - context.session.startedAt;

            const mousePosition = (event.type === 'CAPTURE_SNAPSHOT' && event.mousePosition)
                ? event.mousePosition
                : context.session.lastMousePosition;

            const snapshot = createSnapshot(
                editor,
                timestamp,
                {
                    ...mousePosition,
                    visible: isMouseMovement ? true : mousePosition.visible,
                },
                context.getSlideState,
                context.getPreviewState
            );

            return {
                session: {
                    ...context.session,
                    snapshots: [...context.session.snapshots, snapshot],
                    lastMousePosition: mousePosition,
                },
                currentSnapshot: snapshot,
            };
        }),



        finalizeRecording: assign(({ context }) => {
            if (!context.session) return { recording: null };

            // Base duration from session timing
            const duration = Math.max(Date.now() - context.session.startedAt, 1);
            const slides = context.getSlides?.();

            const recording: Recording = {
                id: Date.now().toString(),
                name: `Recording ${Date.now()}`,
                createdAt: Date.now(),
                snapshots: context.session.snapshots,
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
                lastAppliedSnapshotIndex: -1,
                lastAppliedPreviewEventIndex: -1,
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
                lastAppliedSnapshotIndex: -1,
                lastAppliedPreviewEventIndex: -1,
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

        applySnapshotAtTime: assign(({ context, event }) => {
            const { recording, editorRefs, lastAppliedSnapshotIndex } = context;
            const currentTime = (event.type === 'TICK' ? event.currentTime : (event.type === 'SEEK' ? event.time : context.timeline.currentTime));

            if (!recording?.snapshots.length || !editorRefs.editor) {
                return {};
            }

            const snapshotIndex = findSnapshotIndexAtTime(recording.snapshots, currentTime, lastAppliedSnapshotIndex);

            if (snapshotIndex === lastAppliedSnapshotIndex && lastAppliedSnapshotIndex !== -1) {
                return {};
            }

            const snapshot = recording.snapshots[snapshotIndex];
            if (!snapshot || !snapshot.state || !isValidSnapshotState(snapshot.state)) {
                return { lastAppliedSnapshotIndex: snapshotIndex };
            }

            const newDecorations = applyEditorState(
                editorRefs.editor,
                snapshot,
                editorRefs.cursorDecorations,
                true
            );

            if (snapshot.state.slideState && snapshot.state.currentSlideIndex !== undefined && context.applySlideState) {
                context.applySlideState(snapshot.state.slideState, snapshot.state.currentSlideIndex);
            }

            let nextAppliedPreviewState = context.lastAppliedPreviewState;
            if (snapshot.state.previewState && context.applyPreviewState) {
                const nextState = snapshot.state.previewState;
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
                currentSnapshot: snapshot,
                lastAppliedSnapshotIndex: snapshotIndex,
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
                lastAppliedSnapshotIndex: -1,
                lastAppliedPreviewEventIndex: -1, // Reset so we can re-scan and apply correct state
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
            currentSnapshot: null,
            lastAppliedSnapshotIndex: -1,
            lastAppliedPreviewEventIndex: -1,
            lastAppliedPreviewState: undefined,
        })),

        clearRecording: assign({
            recording: null,
            currentSnapshot: null,
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
            for (let i = newLastIndex + 1; i < previewEvents.length; i++) {
                const event = previewEvents[i];
                if (event.timestamp <= currentTime) {
                    // Apply this event
                    const nextState = {
                        size: event.size || 'small',
                        scrollTop: event.scrollTop,
                        scrollLeft: event.scrollLeft,
                        currentInteraction: event.interaction,
                    };

                    applyPreviewState(nextState);
                    nextAppliedPreviewState = nextState;
                    newLastIndex = i;
                } else {
                    // Events are sorted by timestamp, so stop here
                    break;
                }
            }

            if (newLastIndex !== lastAppliedPreviewEventIndex || nextAppliedPreviewState !== context.lastAppliedPreviewState) {
                return {
                    lastAppliedPreviewEventIndex: newLastIndex,
                    lastAppliedPreviewState: nextAppliedPreviewState
                };
            }

            return {};
        }),
    },

}).createMachine({
    id: 'editor',
    context: ({ input }) => ({
        timeline: {
            currentTime: 0,
            duration: 0,
            speed: input.defaultPlaybackSpeed ?? 1,
            volume: 1,
            startedAt: 0,
            pausedDuration: 0,
            pausedAt: 0,
        },
        session: null,
        recording: null,
        currentSnapshot: null,
        audio: {
            blob: null,
            element: null,
            isRecording: false,
            mediaRecorder: null,
            chunks: [],
            mimeType: '',
        },
        editorRefs: {
            editor: input.editorRef.current,
            cursorDecorations: [],
        },
        enableAudioRecording: input.enableAudioRecording ?? false,
        pauseOnUserInteraction: input.pauseOnUserInteraction ?? true,
        animationFrameId: null,
        error: null,
        lastAppliedSnapshotIndex: -1,
        lastAppliedPreviewEventIndex: -1,
        applySlideState: input.applySlideState,
        applySlides: input.applySlides,
        getSlideState: input.getSlideState,
        getSlides: input.getSlides,
        applyPreviewState: input.applyPreviewState,
        getPreviewState: input.getPreviewState,
    }),

    initial: 'idle',
    on: {
        SET_EDITOR_REF: {
            actions: 'setEditorRef',
        },
    },
    states: {
        idle: {
            on: {
                START_RECORDING: {
                    target: 'recording',
                    actions: ['initRecordingSession', 'captureInitialSnapshot'],
                },
                LOAD_RECORDING: 'loading',
            },
        },

        recording: {
            entry: [
                spawnChild('mouseTracking', {
                    id: 'mouseTracker',
                    input: ({ self }) => ({
                        onMouseMove: (pos: { x: number; y: number; visible: boolean }) => {
                            self.send({ type: 'CAPTURE_SNAPSHOT', isMouseMovement: true, mousePosition: pos });
                        },
                    }),
                }),
                enqueueActions(({ context, enqueue }) => {
                    if (context.enableAudioRecording) {
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
                    }
                }),
            ],
            exit: [],
            on: {
                CAPTURE_SNAPSHOT: {
                    actions: 'captureSnapshot',
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
                        'captureSnapshot'
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
                            currentSnapshot: null,
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
                'applySnapshotAtTime',
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
                        'applySnapshotAtTime',
                        'applyPreviewEventsAtTime',
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
                        'applySnapshotAtTime',
                        'applyPreviewEventsAtTime',
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
                        'applySnapshotAtTime',
                        'applyPreviewEventsAtTime',
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
                                    'applySnapshotAtTime',
                                    'applyPreviewEventsAtTime',
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
