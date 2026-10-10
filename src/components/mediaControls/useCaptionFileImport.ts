import { useRef, useState, type ChangeEvent } from "react";
import { createCaptionTrack } from "../../captions/captionTracks";
import { parseCaptionFile } from "../../captions/importCaptionFile";
import { useNextEditorActions, useNextEditorMetadata } from "../../hooks/useNextEditorContext";

/**
 * The caption file picker behind "Import captions…": adds a picked file's cues to the loaded
 * lesson as a track, or keeps what to tell the viewer when it holds none. The player bar
 * renders the hidden input outside the Settings menu, so a pick still lands with it closed.
 */
export function useCaptionFileImport() {
  const { addCaptionTrack } = useNextEditorActions();
  const { currentRecording } = useNextEditorMetadata();
  const inputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const openPicker = () => inputRef.current?.click();

  const onFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";
    setImportError(null);
    // Read before parsing awaits: the track belongs to the lesson the viewer picked it for.
    const recordingId = currentRecording?.id;
    if (!recordingId) return;

    const parsed = await parseCaptionFile(file);
    if ("error" in parsed) {
      setImportError(parsed.error);
      return;
    }

    const { cues, language } = parsed;
    addCaptionTrack(
      recordingId,
      createCaptionTrack({
        id: `${language}-${Date.now()}`,
        language,
        cues,
        isDefault: !currentRecording?.captions?.length,
      }),
    );
  };

  return { inputRef, importError, openPicker, onFileChange };
}
