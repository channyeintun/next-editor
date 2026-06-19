import { useMemo } from "react";
import { Download, FileBox } from "lucide-react";
import {
  approximateBase64ByteLength,
  getWorkspaceFileMimeType,
  getWorkspaceMediaKind,
  type WorkspaceFile,
} from "../types/workspace";

interface BinaryFilePreviewProps {
  file: WorkspaceFile;
}

function formatByteSize(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = byteLength / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Renders an uploaded binary asset (image/video/audio/other) in place of the
 * Monaco editor, since its base64 content is not meaningfully editable as text.
 */
const BinaryFilePreview: React.FC<BinaryFilePreviewProps> = ({ file }) => {
  const mimeType = getWorkspaceFileMimeType(file.path);
  const mediaKind = getWorkspaceMediaKind(file.path);
  const dataUrl = useMemo(
    () => `data:${mimeType};base64,${file.content}`,
    [mimeType, file.content],
  );
  const byteSize = formatByteSize(approximateBase64ByteLength(file.content));

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-auto bg-[#11141c] p-8 text-slate-300">
      <div className="flex max-h-[60%] max-w-full items-center justify-center">
        {mediaKind === "image" ? (
          <img
            src={dataUrl}
            alt={file.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
          />
        ) : mediaKind === "video" ? (
          <video src={dataUrl} controls className="max-h-full max-w-full rounded-lg shadow-lg" />
        ) : mediaKind === "audio" ? (
          <audio src={dataUrl} controls className="w-80 max-w-full" />
        ) : (
          <div className="flex size-28 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900">
            <FileBox size={44} className="text-slate-500" />
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium text-slate-100">{file.name}</p>
        <p className="text-xs text-slate-500">
          {mimeType} · {byteSize}
        </p>
        <p className="max-w-sm text-xs text-slate-500">
          Binary asset stored in this workspace. Reference it from your code with
          <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
            /{file.path}
          </code>
        </p>
      </div>

      <a
        href={dataUrl}
        download={file.name}
        className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
      >
        <Download size={14} />
        Download
      </a>
    </div>
  );
};

export default BinaryFilePreview;
