import { fromCallback, type ActorRefFrom } from 'xstate';

// ============================================================================
// Audio Actor Types
// ============================================================================

export interface AudioRecordingInput {
    /** Audio constraints */
    constraints?: MediaTrackConstraints;
}

export interface AudioPlaybackInput {
    /** Audio blob to play */
    blob: Blob;
    /** Initial volume (0-1) */
    volume: number;
    /** Initial playback rate */
    playbackRate: number;
    /** Starting position in seconds */
    startPosition: number;
}

export type AudioRecordingEvent =
    | { type: 'START' }
    | { type: 'STOP' };

export type AudioPlaybackEvent =
    | { type: 'PLAY' }
    | { type: 'PAUSE' }
    | { type: 'SEEK'; time: number }
    | { type: 'SET_VOLUME'; volume: number }
    | { type: 'SET_PLAYBACK_RATE'; rate: number }
    | { type: 'SYNC'; time: number };

export type AudioRecordingEmit =
    | { type: 'STARTED'; mediaRecorder: MediaRecorder; mimeType: string }
    | { type: 'CHUNK'; chunk: Blob }
    | { type: 'STOPPED'; blob: Blob }
    | { type: 'ERROR'; error: string };

export type AudioPlaybackEmit =
    | { type: 'READY'; duration: number }
    | { type: 'FINISHED' }
    | { type: 'ERROR'; error: string };

// ============================================================================
// Audio Recording Actor
// ============================================================================

/**
 * Get the best supported audio MIME type
 */
const getSupportedAudioMimeType = (): string => {
    const mimeTypes = [
        'audio/webm; codecs=opus',
        'audio/webm',
        'audio/mp4; codecs=mp4a.40.2',
        'audio/mp4',
        'audio/ogg; codecs=opus',
        'audio/ogg',
        'audio/wav',
        'audio/mpeg'
    ];

    if (typeof MediaRecorder === 'undefined') {
        return '';
    }

    for (const mimeType of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
            return mimeType;
        }
    }

    return '';
};

/**
 * Audio recording actor - manages MediaRecorder lifecycle
 */
export const audioRecordingActor = fromCallback<AudioRecordingEvent, AudioRecordingInput, AudioRecordingEmit>(
    ({ sendBack, receive, input }) => {
        let mediaRecorder: MediaRecorder | null = null;
        let stream: MediaStream | null = null;
        let chunks: Blob[] = [];
        let mimeType = '';

        const startRecording = async () => {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: input.constraints ?? {
                        autoGainControl: true,
                        echoCancellation: true,
                        noiseSuppression: true,
                        channelCount: 1,
                        sampleRate: 16000,
                    }
                });

                mimeType = getSupportedAudioMimeType();
                if (!mimeType) {
                    sendBack({ type: 'ERROR', error: 'No supported audio MIME type found' });
                    return;
                }

                mediaRecorder = new MediaRecorder(stream, {
                    audioBitsPerSecond: 32000,
                    mimeType,
                });

                chunks = [];

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        chunks.push(event.data);
                        sendBack({ type: 'CHUNK', chunk: event.data });
                    }
                };

                mediaRecorder.onstop = () => {
                    const blob = new Blob(chunks, { type: mimeType });
                    sendBack({ type: 'STOPPED', blob });

                    // Clean up stream
                    if (stream) {
                        stream.getTracks().forEach(track => track.stop());
                        stream = null;
                    }
                };

                mediaRecorder.onerror = () => {
                    sendBack({ type: 'ERROR', error: 'MediaRecorder error' });
                };

                mediaRecorder.start();
                sendBack({ type: 'STARTED', mediaRecorder, mimeType });
            } catch (error) {
                sendBack({
                    type: 'ERROR',
                    error: error instanceof Error ? error.message : 'Failed to start recording'
                });
            }
        };

        const stopRecording = () => {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
            }
        };

        receive((event) => {
            switch (event.type) {
                case 'START':
                    startRecording();
                    break;
                case 'STOP':
                    stopRecording();
                    break;
            }
        });

        return () => {
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
            }
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
            }
        };
    }
);

// ============================================================================
// Audio Playback Actor
// ============================================================================

/**
 * Audio playback actor - manages AudioContext for precise synchronized playback
 */
export const audioPlaybackActor = fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
    ({ sendBack, receive, input }) => {
        const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        const ctx = new AudioContextClass();
        let audioBuffer: AudioBuffer | null = null;
        let source: AudioBufferSourceNode | null = null;
        const gainNode = ctx.createGain();
        gainNode.connect(ctx.destination);
        gainNode.gain.value = input.volume;

        // Playback state
        let startTime = 0; // When the current source started playing in ctx time
        let pauseOffset = input.startPosition; // Where we paused (in seconds)
        let isPlaying = false;
        let playbackRate = input.playbackRate;

        const cleanupSource = () => {
            if (source) {
                try {
                    source.stop();
                    source.disconnect();
                } catch { /* ignore */ }
                source = null;
            }
        };

        const play = (offset: number) => {
            if (!audioBuffer) return;
            cleanupSource();

            source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = playbackRate;
            source.connect(gainNode);

            source.onended = () => {
                const currentPos = getPosition();
                if (currentPos >= audioBuffer!.duration - 0.01) {
                    sendBack({ type: 'FINISHED' });
                    isPlaying = false;
                }
            };

            const actualOffset = Math.max(0, Math.min(offset, audioBuffer.duration));
            source.start(0, actualOffset);

            startTime = ctx.currentTime - (actualOffset / playbackRate);
            pauseOffset = actualOffset;
            isPlaying = true;
        };

        const getPosition = (): number => {
            if (!isPlaying) return pauseOffset;
            return (ctx.currentTime - startTime) * playbackRate;
        };

        // Initialize: Load and decode audio
        const init = async () => {
            try {
                const arrayBuffer = await input.blob.arrayBuffer();
                audioBuffer = await ctx.decodeAudioData(arrayBuffer);
                sendBack({ type: 'READY', duration: audioBuffer.duration * 1000 });
            } catch (error) {
                sendBack({
                    type: 'ERROR',
                    error: error instanceof Error ? error.message : 'Failed to decode audio'
                });
            }
        };

        init();

        receive((event) => {
            switch (event.type) {
                case 'PLAY':
                    if (ctx.state === 'suspended') ctx.resume();
                    play(getPosition());
                    break;

                case 'PAUSE':
                    pauseOffset = getPosition();
                    cleanupSource();
                    isPlaying = false;
                    break;

                case 'SEEK': {
                    const seekTime = event.time / 1000;
                    pauseOffset = seekTime;
                    if (isPlaying) {
                        play(seekTime);
                    }
                    break;
                }

                case 'SET_VOLUME':
                    gainNode.gain.setTargetAtTime(
                        Math.max(0, Math.min(1, event.volume)),
                        ctx.currentTime,
                        0.01
                    );
                    break;

                case 'SET_PLAYBACK_RATE':
                    playbackRate = event.rate;
                    if (isPlaying) {
                        play(getPosition());
                    }
                    break;

                case 'SYNC': {
                    if (!isPlaying || !audioBuffer) return;

                    const targetTime = event.time / 1000;
                    const currentPos = getPosition();
                    const diff = Math.abs(currentPos - targetTime);

                    // With AudioContext, drift should be minimal. 
                    // Only re-sync if it's significant (> 50ms) to avoid glitching
                    if (diff > 0.05) {
                        play(targetTime);
                    }
                    break;
                }
            }
        });

        return () => {
            cleanupSource();
            ctx.close().catch(() => { });
        };
    }
);

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;
