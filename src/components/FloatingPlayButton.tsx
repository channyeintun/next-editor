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
            <span className="play-icon" />
        </button>
    );
};

export default FloatingPlayButton;
