// Phase 1 placeholder protocol: the versioned discriminated union grows in
// Phase 6. Both sides ignore unknown message types.
export const PROTOCOL_VERSION = 1;

export type RecordingMetadataPayload = {
  fileName: string;
  byteLength: number;
};

export type HostToWebviewMessage =
  | { type: "host.hello"; protocolVersion: number }
  | { type: "recording.metadata"; payload: RecordingMetadataPayload };

export type WebviewToHostMessage = {
  type: "webview.ready";
  protocolVersion: number;
};
