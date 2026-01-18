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

                mediaRecorder.onstart = () => {
                    sendBack({ type: 'STARTED', mediaRecorder, mimeType });
                };

                mediaRecorder.start();
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
 * Audio playback actor - manages HTMLAudioElement for robust synchronized playback
 */
export const audioPlaybackActor = fromCallback<AudioPlaybackEvent, AudioPlaybackInput, AudioPlaybackEmit>(
    ({ sendBack, receive, input }) => {
        let audio: HTMLAudioElement | null = null;
        let audioUrl: string | null = null;

        const cleanup = () => {
            if (audio) {
                audio.pause();
                audio.src = '';
                audio.load();
                audio = null;
            }
            if (audioUrl) {
                URL.revokeObjectURL(audioUrl);
                audioUrl = null;
            }
        };

        const init = () => {
            try {
                audioUrl = URL.createObjectURL(input.blob);
                audio = new Audio(audioUrl);
                audio.volume = input.volume;
                audio.playbackRate = input.playbackRate;
                audio.currentTime = input.startPosition;

                audio.oncanplaythrough = () => {
                    if (audio) {
                        sendBack({ type: 'READY', duration: audio.duration * 1000 });
                    }
                };

                audio.onended = () => {
                    sendBack({ type: 'FINISHED' });
                };

                audio.onerror = () => {
                    sendBack({ type: 'ERROR', error: 'Audio playback error' });
                };

                // For iOS, we might need a user gesture to start, 
                // but the machine handles PLAY event on user gesture.
            } catch (error) {
                sendBack({
                    type: 'ERROR',
                    error: error instanceof Error ? error.message : 'Failed to initialize audio'
                });
            }
        };

        init();

        receive((event) => {
            if (!audio) return;

            switch (event.type) {
                case 'PLAY':
                    audio.play().catch(err => {
                        // On some browsers, play() might fail if not triggered by user gesture
                        // even if the AudioContext was unlocked.
                        console.warn('[AudioActor] Play failed:', err);
                    });
                    break;

                case 'PAUSE':
                    audio.pause();
                    break;

                case 'SEEK':
                    audio.currentTime = event.time / 1000;
                    break;

                case 'SET_VOLUME':
                    audio.volume = Math.max(0, Math.min(1, event.volume));
                    break;

                case 'SET_PLAYBACK_RATE':
                    audio.playbackRate = event.rate;
                    break;

                case 'SYNC': {
                    const targetTime = event.time / 1000;
                    const diff = Math.abs(audio.currentTime - targetTime);

                    // Re-sync if drift is significant (> 150ms for HTMLAudioElement)
                    // HTMLAudioElement is less precise than AudioContext, so we use a larger threshold
                    if (diff > 0.15) {
                        audio.currentTime = targetTime;
                    }
                    break;
                }
            }
        });

        return cleanup;
    }
);

export type AudioRecordingActorRef = ActorRefFrom<typeof audioRecordingActor>;
export type AudioPlaybackActorRef = ActorRefFrom<typeof audioPlaybackActor>;
