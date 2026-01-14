import { useScrimbaContext } from '../hooks/useScrimbaContext';
import '../App.css';

/**
 * Floating play button that appears in the center of the screen
 * when a recording is loaded and not currently playing.
 * Clicking it triggers playback of the recording.
 */
const FloatingPlayButton = () => {
    const { currentRecording, isPlaying, isRecording, play } = useScrimbaContext();

    // Only show when there's a recording loaded and not currently playing or recording
    const shouldShow = currentRecording && !isPlaying && !isRecording;

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
