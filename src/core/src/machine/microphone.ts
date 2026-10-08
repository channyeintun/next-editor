// The microphone policy a take records with. The take (audioRecordingActor) and the
// microphone check both open the microphone through `openMicrophone`, so the check hears
// exactly what the take will record.

/**
 * The microphone constraints every take records with. The machine spawns the
 * recorder without its own, so this is the one place they are set. Requesting
 * mono or a lower sample rate would be a separate product decision.
 */
const DEFAULT_MIC_CONSTRAINTS: MediaTrackConstraints = {
  autoGainControl: true,
  echoCancellation: true,
  noiseSuppression: true,
};

/**
 * What a take asks the microphone for: the recording defaults, from `deviceId` when the
 * author picked one. The microphone check listens with the same (through
 * `openMicrophone`), so its meter shows the level the take will record.
 */
function microphoneConstraints(deviceId?: string): MediaTrackConstraints {
  return deviceId
    ? { ...DEFAULT_MIC_CONSTRAINTS, deviceId: { exact: deviceId } }
    : DEFAULT_MIC_CONSTRAINTS;
}

/** A picked microphone that is not there (unplugged, or an id from another browser profile). */
function isMissingDevice(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "OverconstrainedError" || name === "NotFoundError";
}

/**
 * Opens the microphone a take records from: the recording defaults on the picked device,
 * falling back to the default device when it is gone.
 */
export async function openMicrophone({ deviceId }: { deviceId?: string }): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(deviceId),
    });
  } catch (error) {
    // A take is not lost to a missing device: it records from the default microphone.
    if (!deviceId || !isMissingDevice(error)) throw error;
    console.warn("The chosen microphone is unavailable; recording from the default one.", error);
    return navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
  }
}
