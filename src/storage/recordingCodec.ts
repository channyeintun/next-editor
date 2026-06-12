import type { Recording } from "../core/src";
import type { AudioPlaceholder } from "../core/src/types";
import { decodeBase64, encodeBase64 } from "../core/src/utils/base64";
import { normalizeRecordingData } from "../core/src/utils/editorState";
import { deflate, inflate } from "pako";
import { superjson } from "./SuperJsonConfig";

const RECORDING_MAGIC_NUMBER = "SCRM";
const RECORDING_BINARY_VERSION = 2;
const RECORDING_HEADER_SIZE = 10;

function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }

      reject(new Error("Failed to read audio blob as ArrayBuffer"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read audio blob"));
    };
    reader.readAsArrayBuffer(blob);
  });
}

export function normalizeRecording(recording: Recording): Recording {
  if (recording.version === 2 || recording.version === 3) {
    return normalizeRecordingData(recording);
  }

  throw new Error(
    `Unsupported recording version: ${(recording as Recording & { version?: unknown }).version ?? "unknown"}`,
  );
}

async function extractAudioData(recording: Recording): Promise<{
  recordingWithPlaceholders: Recording;
  audioData: Uint8Array | null;
}> {
  if (!recording.audioBlob || !(recording.audioBlob instanceof Blob)) {
    return { recordingWithPlaceholders: recording, audioData: null };
  }

  const arrayBuffer = await readBlobAsArrayBuffer(recording.audioBlob);
  const audioData = new Uint8Array(arrayBuffer);
  const placeholder: AudioPlaceholder = {
    __audio_offset: 0,
    __audio_size: audioData.length,
    __audio_type: recording.audioBlob.type,
  };

  return {
    recordingWithPlaceholders: {
      ...recording,
      audioBlob: placeholder,
    },
    audioData,
  };
}

export async function compressRecordingsToBinary(recordings: Recording[]): Promise<Uint8Array> {
  const audioChunks: Uint8Array[] = [];
  let currentOffset = 0;

  const recordingsWithPlaceholders = await Promise.all(
    recordings.map(async (recording) => {
      const normalizedRecording = normalizeRecording(recording);
      const { recordingWithPlaceholders, audioData } = await extractAudioData(normalizedRecording);

      if (audioData) {
        const placeholder = recordingWithPlaceholders.audioBlob as AudioPlaceholder;
        placeholder.__audio_offset = currentOffset;
        audioChunks.push(audioData);
        currentOffset += audioData.length;
      }

      return recordingWithPlaceholders;
    }),
  );

  const jsonString = superjson.stringify(recordingsWithPlaceholders);
  const compressedJson = deflate(jsonString, { level: 9 });
  const audioDataSize = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const totalSize = RECORDING_HEADER_SIZE + compressedJson.length + audioDataSize;
  const result = new Uint8Array(totalSize);
  let offset = 0;

  result.set(new TextEncoder().encode(RECORDING_MAGIC_NUMBER), offset);
  offset += 4;
  result.set(new Uint8Array(new Uint16Array([RECORDING_BINARY_VERSION]).buffer), offset);
  offset += 2;
  result.set(new Uint8Array(new Uint32Array([compressedJson.length]).buffer), offset);
  offset += 4;
  result.set(compressedJson, offset);
  offset += compressedJson.length;

  for (const audioChunk of audioChunks) {
    result.set(audioChunk, offset);
    offset += audioChunk.length;
  }

  return result;
}

export async function decompressBinaryToRecordings(binaryData: Uint8Array): Promise<Recording[]> {
  let offset = 0;
  const magic = new TextDecoder().decode(binaryData.slice(offset, offset + 4));
  offset += 4;

  if (magic !== RECORDING_MAGIC_NUMBER) {
    throw new Error("Invalid binary format: bad magic number");
  }

  const version = new Uint16Array(binaryData.slice(offset, offset + 2).buffer)[0];
  offset += 2;

  if (version !== RECORDING_BINARY_VERSION) {
    throw new Error(
      `Unsupported binary format version: ${version}. Legacy Version 1 is no longer supported.`,
    );
  }

  const jsonLength = new Uint32Array(binaryData.slice(offset, offset + 4).buffer)[0];
  offset += 4;

  if (jsonLength === 0 || jsonLength > binaryData.length - offset) {
    throw new Error(
      `Invalid JSON length: ${jsonLength}, remaining data: ${binaryData.length - offset}`,
    );
  }

  const compressedJson = binaryData.slice(offset, offset + jsonLength);
  offset += jsonLength;

  const jsonString = inflate(compressedJson, { to: "string" });

  if (!jsonString || typeof jsonString !== "string") {
    throw new Error("Failed to decompress JSON data - inflate returned invalid result");
  }

  const recordings = superjson.parse(jsonString) as Recording[];
  const audioData = binaryData.slice(offset);

  return recordings.map((rawRecording) => {
    const recording = normalizeRecording(rawRecording);
    const audioPlaceholder = recording.audioBlob as AudioPlaceholder | undefined;

    if (audioPlaceholder && "__audio_offset" in audioPlaceholder) {
      const audioOffset = audioPlaceholder.__audio_offset;
      const audioSize = audioPlaceholder.__audio_size;
      const audioType = audioPlaceholder.__audio_type;
      const audioBytes = audioData.slice(audioOffset, audioOffset + audioSize);
      recording.audioBlob = new Blob([audioBytes], { type: audioType });
    }

    return recording;
  });
}

export async function encodeRecordingsToBase64(recordings: Recording[]): Promise<string> {
  return encodeBase64(await compressRecordingsToBinary(recordings));
}

export async function decodeBase64ToRecordings(base64Data: string): Promise<Recording[]> {
  return decompressBinaryToRecordings(decodeBase64(base64Data));
}
