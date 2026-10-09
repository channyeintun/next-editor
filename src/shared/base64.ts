// Standard base64 for byte payloads that travel as text: collaboration Yjs
// updates, snapshots and relative positions, workspace assets, studio audio
// and tokenizer models, and the Worker's stored room snapshots. Encoding is
// chunked so String.fromCharCode's argument list stays small for
// multi-megabyte inputs.
const BINARY_CHUNK_SIZE = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BINARY_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BINARY_CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
