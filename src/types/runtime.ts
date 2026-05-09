export interface RuntimeRecordingSnapshot {
  mode: "single-file" | "webcontainer";
  status: string;
  previewUrl?: string | null;
  terminalOutput?: string | null;
}
