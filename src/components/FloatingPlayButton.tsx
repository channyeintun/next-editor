import { useNextEditorActions, useNextEditorMetadata, useNextEditorPlayback } from '../hooks/useNextEditorContext';
import '../App.css';

/**
 * Floating play button that appears in the center of the screen
 * when a recording is loaded and not currently playing.
 * Clicking it triggers playback of the recording.
 */
const FloatingPlayButton = () => {
    const { play } = useNextEditorActions();
    const { currentRecording, isPlaying, isRecording } = useNextEditorMetadata();
    const { currentTime } = useNextEditorPlayback();

    // Only show when there's a recording loaded, not currently playing or recording, and progress is at zero
    const shouldShow = currentRecording && !isPlaying && !isRecording && currentTime === 0;

    if (!shouldShow) {
        return null;
    }

    return (
        <button className="floating-play-button" onClick={play}>
            <svg viewBox="0 0 256 256" className="zr-ce w-20 h-20 fill-white">
                <path d="M240,128a15.74,15.74,0,0,1-7.6,13.51L88.32,229.65a16,16,0,0,1-16.2.3A15.86,15.86,0,0,1,64,216.13V39.87a15.86,15.86,0,0,1,8.12-13.82,16,16,0,0,1,16.2.3L232.4,114.49A15.74,15.74,0,0,1,240,128Z" pathLength="100"></path>
            </svg>
        </button>
    );
};

export default FloatingPlayButton;
