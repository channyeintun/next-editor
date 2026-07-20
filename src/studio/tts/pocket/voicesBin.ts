/**
 * Parsers for the pocket-tts ONNX bundle's binary sidecars, ported from the
 * pocket-tts-web demo (Apache-2.0, KevinAHM/pocket-tts-web@d0c0c79):
 * - `voices.bin` (PTVB1): per-voice precomputed flow-LM state tensors, so
 *   built-in voices need no reference audio or mimi encoder at runtime.
 * - `.npy` float32 tensors (the learned BOS-before-voice embedding).
 */

export type VoiceTensorDtype = "float32" | "int64" | "bool";

export interface VoiceTensor {
  data: Float32Array | BigInt64Array | Uint8Array;
  shape: number[];
  dtype: VoiceTensorDtype;
}

export type VoiceRecord = Record<string, VoiceTensor>;

export function parseVoiceStatesBin(buffer: ArrayBuffer): Record<string, VoiceRecord> {
  const view = new DataView(buffer);
  let offset = 0;
  const magic = new TextDecoder().decode(new Uint8Array(buffer, offset, 5));
  offset += 5;
  if (magic !== "PTVB1") {
    throw new Error("Invalid voices.bin header");
  }

  const voices: Record<string, VoiceRecord> = {};
  const voiceCount = view.getUint32(offset, true);
  offset += 4;

  for (let voiceIndex = 0; voiceIndex < voiceCount; voiceIndex++) {
    const nameLen = view.getUint16(offset, true);
    offset += 2;
    const name = new TextDecoder().decode(new Uint8Array(buffer, offset, nameLen));
    offset += nameLen;

    const tensorCount = view.getUint16(offset, true);
    offset += 2;
    const tensors: VoiceRecord = {};

    for (let tensorIndex = 0; tensorIndex < tensorCount; tensorIndex++) {
      const keyLen = view.getUint16(offset, true);
      offset += 2;
      const key = new TextDecoder().decode(new Uint8Array(buffer, offset, keyLen));
      offset += keyLen;

      const dtypeCode = view.getUint8(offset);
      offset += 1;
      const rank = view.getUint8(offset);
      offset += 1;

      const shape: number[] = [];
      for (let dimIndex = 0; dimIndex < rank; dimIndex++) {
        shape.push(view.getUint32(offset, true));
        offset += 4;
      }

      const byteLength = view.getUint32(offset, true);
      offset += 4;

      let data: VoiceTensor["data"];
      let dtype: VoiceTensorDtype;
      if (dtypeCode === 0) {
        data = new Float32Array(buffer.slice(offset, offset + byteLength));
        dtype = "float32";
      } else if (dtypeCode === 1) {
        data = new BigInt64Array(buffer.slice(offset, offset + byteLength));
        dtype = "int64";
      } else if (dtypeCode === 2) {
        data = new Uint8Array(buffer.slice(offset, offset + byteLength));
        dtype = "bool";
      } else {
        throw new Error(`Unsupported voices.bin dtype code: ${dtypeCode}`);
      }
      offset += byteLength;

      tensors[key] = { data, shape, dtype };
    }

    voices[name] = tensors;
  }

  return voices;
}

export interface NpyFloat32 {
  data: Float32Array;
  shape: number[];
}

export function parseNpyFloat32(buffer: ArrayBuffer): NpyFloat32 {
  const view = new DataView(buffer);
  const magic = new Uint8Array(buffer, 0, 6);
  const expected = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59];
  for (let i = 0; i < expected.length; i++) {
    if (magic[i] !== expected[i]) {
      throw new Error("Invalid NPY file");
    }
  }

  const major = view.getUint8(6);
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerOffset = major === 1 ? 10 : 12;
  const headerText = new TextDecoder().decode(new Uint8Array(buffer, headerOffset, headerLen));
  const shapeMatch = headerText.match(/\(\s*([0-9,\s]+)\)/);
  if (!shapeMatch) {
    throw new Error("Could not parse NPY shape");
  }
  const shape = shapeMatch[1]
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10));
  const dataOffset = headerOffset + headerLen;
  return { data: new Float32Array(buffer.slice(dataOffset)), shape };
}
