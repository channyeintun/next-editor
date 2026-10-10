import { requestToPromise, transactionToPromise } from "../../storage/idb";
import { sha256Hex } from "../hash";
import {
  VOXCPM2_MAX_REFERENCE_SECONDS,
  VOXCPM2_MIN_REFERENCE_SECONDS,
  VOXCPM2_REFERENCE_SAMPLE_RATE,
} from "./voxcpm2Protocol";

/**
 * User reference voices, stored locally in IndexedDB as prepared 24 kHz mono
 * samples. Pocket-TTS derives its voice state entirely in the browser. When
 * explicitly selected for Burmese Modal narration, the same sample is sent
 * through the authenticated Worker to Modal for speaker conditioning, as the
 * input of each narration job. The Worker does not keep it; Modal stores each
 * job's input and keeps the job's audio for up to 7 days.
 */

/** Stored samples are 24 kHz: what Pocket-TTS conditions on, and what VoxCPM2's Worker requires. */
export const VOICE_SAMPLE_RATE = VOXCPM2_REFERENCE_SAMPLE_RATE;
/** Reference sample bounds: enough voice to condition on, small enough to store. */
export const MIN_SAMPLE_SECONDS = 2;
/** VoxCPM2 needs a longer reference to preserve one speaker reliably. */
export const MIN_VOXCPM2_REFERENCE_SECONDS = VOXCPM2_MIN_REFERENCE_SECONDS;
/** A stored sample is sent as it is as a VoxCPM2 reference, so it keeps to the Worker's limit. */
export const MAX_SAMPLE_SECONDS = VOXCPM2_MAX_REFERENCE_SECONDS;

/**
 * Whether a narrator reference can condition Burmese VoxCPM2 narration: long
 * enough to keep one speaker, and within the stored-sample limit.
 */
export function isVoxCpm2ReferenceReady(voice: {
  samples: Float32Array;
  sampleRate: number;
}): boolean {
  const durationSeconds = voice.samples.length / voice.sampleRate;
  return durationSeconds >= MIN_VOXCPM2_REFERENCE_SECONDS && durationSeconds <= MAX_SAMPLE_SECONDS;
}

/** Whether a prepared (VOICE_SAMPLE_RATE) sample is too short for a VoxCPM2 reference. */
export function voxCpm2ReferenceTooShort(samples: Float32Array): boolean {
  return samples.length < MIN_VOXCPM2_REFERENCE_SECONDS * VOICE_SAMPLE_RATE;
}

export interface SavedCustomVoice {
  id: string;
  name: string;
  createdAtIso: string;
  sampleRate: typeof VOICE_SAMPLE_RATE;
  samples: Float32Array;
  /** Content hash of the sample — part of the TTS cache key. */
  sampleSha256: string;
}

const DB_NAME = "next-editor-studio-voices";
const STORE = "voices";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

/** Clamp a prepared sample to the supported bounds (trims the tail). */
export function clampVoiceSamples(samples: Float32Array, sampleRate: number): Float32Array {
  const min = MIN_SAMPLE_SECONDS * sampleRate;
  const max = MAX_SAMPLE_SECONDS * sampleRate;
  if (samples.length < min) {
    throw new Error(
      `Voice sample too short — record at least ${MIN_SAMPLE_SECONDS}s of clear speech`,
    );
  }
  return samples.length > max ? samples.slice(0, max) : samples;
}

/**
 * Decode any browser-supported audio (wav/mp3/webm/…) and resample it to the
 * pocket-tts reference format: 24 kHz mono float32.
 */
export async function prepareVoiceSample(bytes: ArrayBuffer): Promise<Float32Array> {
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes.slice(0));
  } finally {
    await probe.close();
  }

  const targetLength = Math.ceil(decoded.duration * VOICE_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, targetLength, VOICE_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  return clampVoiceSamples(rendered.getChannelData(0), VOICE_SAMPLE_RATE);
}

export async function saveCustomVoice(
  name: string,
  samples: Float32Array,
): Promise<SavedCustomVoice> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the voice a name");
  const sampleSha256 = await sha256Hex(new Uint8Array(samples.buffer.slice(0)));
  const voice: SavedCustomVoice = {
    id: `${Date.now().toString(36)}-${sampleSha256.slice(0, 8)}`,
    name: trimmed,
    createdAtIso: new Date().toISOString(),
    sampleRate: VOICE_SAMPLE_RATE,
    samples,
    sampleSha256,
  };
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(voice);
    await transactionToPromise(tx);
  } finally {
    db.close();
  }
  return voice;
}

export async function listCustomVoices(): Promise<SavedCustomVoice[]> {
  const db = await openDb();
  try {
    const all = await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll(),
    );
    return (all as SavedCustomVoice[]).sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));
  } finally {
    db.close();
  }
}

export async function getCustomVoice(id: string): Promise<SavedCustomVoice | null> {
  const db = await openDb();
  try {
    const voice = await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).get(id),
    );
    return (voice as SavedCustomVoice | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function deleteCustomVoice(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    await transactionToPromise(tx);
  } finally {
    db.close();
  }
}
