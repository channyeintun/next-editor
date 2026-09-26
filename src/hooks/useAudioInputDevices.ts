import { useEffect, useState } from "react";

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

/**
 * The microphones to choose from. Chrome's "default" and "communications" entries are
 * aliases of real devices (the system default covers them); labels stay empty until the
 * page may use the microphone, so those get numbered names.
 */
export function listAudioInputs(devices: readonly MediaDeviceInfo[]): AudioInputDevice[] {
  return devices
    .filter(
      (device) =>
        device.kind === "audioinput" &&
        device.deviceId !== "" &&
        device.deviceId !== "default" &&
        device.deviceId !== "communications",
    )
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label || `Microphone ${index + 1}`,
    }));
}

/**
 * The microphones connected now, kept current as devices come and go. Listing again when
 * `permissionStream` changes picks up the real names once the page may use the microphone.
 */
export function useAudioInputDevices(permissionStream: MediaStream | null): AudioInputDevice[] {
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const load = async () => {
      try {
        const listed = listAudioInputs(await mediaDevices.enumerateDevices());
        if (!cancelled) setDevices(listed);
      } catch {
        // Listing is a convenience: without it only the default microphone is offered.
      }
    };
    void load();
    mediaDevices.addEventListener?.("devicechange", load);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.("devicechange", load);
    };
  }, [permissionStream]);

  return devices;
}
