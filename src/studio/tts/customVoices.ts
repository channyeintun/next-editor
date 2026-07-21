import { sha256Hex } from "../hash";

/**
 * Cloned voices (pocket-tts voice cloning): the user's reference audio,
 * stored locally in IndexedDB. The voice itself is derived at render time —
 * the sample runs through the bundle's mimi encoder and one flow-LM
 * conditioning pass (see pocket/engine.ts) — so the stored artifact is only
 * the prepared 24 kHz mono sample. Voices never leave the browser.
 */

export const VOICE_SAMPLE_RATE = 24_000;
/** Reference sample bounds: enough voice to condition on, small enough to store. */
export const MIN_SAMPLE_SECONDS = 2;
export const MAX_SAMPLE_SECONDS = 20;

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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
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
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed"));
    });
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
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
    });
  } finally {
    db.close();
  }
}
