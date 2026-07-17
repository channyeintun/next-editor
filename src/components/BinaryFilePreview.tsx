import { Download, FileBox, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useOptionalCollaboration } from "../contexts/CollaborationContext";
import {
  approximateBase64ByteLength,
  getWorkspaceFileMimeType,
  getWorkspaceMediaKind,
  isLegacyWorkspaceBinaryFile,
  isWorkspaceAssetFile,
  type WorkspaceFile,
} from "../types/workspace";
import {
  getWorkspaceAssetBlob,
  subscribeWorkspaceAssetAvailability,
} from "../storage/workspaceAssetStore";

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
 * Renders an uploaded binary asset in place of Monaco. Descriptor-backed files
 * use a short-lived object URL; base64 is retained only for legacy migration.
 */
const BinaryFilePreview: React.FC<BinaryFilePreviewProps> = ({ file }) => {
  const collaboration = useOptionalCollaboration();
  const descriptor = isWorkspaceAssetFile(file) ? file.content : null;
  const assetId = descriptor?.assetId;
  const descriptorMimeType = descriptor?.mimeType;
  const descriptorSize = descriptor?.size;
  const mimeType = descriptor?.mimeType ?? getWorkspaceFileMimeType(file.path);
  const mediaKind = getWorkspaceMediaKind(file.path);
  const [loadedAsset, setLoadedAsset] = useState<{ assetId: string; url: string } | null>(null);
  const [unavailableAssetId, setUnavailableAssetId] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const objectUrl = loadedAsset && loadedAsset.assetId === assetId ? loadedAsset.url : null;
  const assetUnavailable = unavailableAssetId === assetId;
  const legacyDataUrl = isLegacyWorkspaceBinaryFile(file)
    ? `data:${mimeType};base64,${file.content}`
    : null;
  const mediaUrl = objectUrl ?? legacyDataUrl;
  const byteSize = formatByteSize(
    descriptor?.size ??
      (isLegacyWorkspaceBinaryFile(file) ? approximateBase64ByteLength(file.content) : 0),
  );
  const isAwaitingSharedAsset = !mediaUrl && Boolean(collaboration?.provider || assetUnavailable);

  useEffect(() => {
    if (!assetId || !descriptorMimeType || descriptorSize === undefined) return;

    let disposed = false;
    let currentUrl: string | null = null;
    const currentDescriptor = {
      kind: "asset" as const,
      assetId,
      mimeType: descriptorMimeType,
      size: descriptorSize,
    };
    const load = () => {
      void getWorkspaceAssetBlob(currentDescriptor)
        .then((blob) => {
          if (disposed) return;
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          const nextUrl = URL.createObjectURL(blob);
          currentUrl = nextUrl;
          setLoadedAsset({ assetId, url: nextUrl });
          setUnavailableAssetId(null);
        })
        .catch(() => {
          if (!disposed) setUnavailableAssetId(assetId);
        });
    };
    load();
    const unsubscribe = subscribeWorkspaceAssetAvailability((availableAssetId) => {
      if (availableAssetId === assetId) load();
    });
    return () => {
      disposed = true;
      unsubscribe();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [assetId, descriptorMimeType, descriptorSize, retryVersion]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-auto bg-[#11141c] p-8 text-slate-300">
      <div className="flex max-h-[60%] max-w-full items-center justify-center">
        {isAwaitingSharedAsset ? (
          <div className="flex size-28 items-center justify-center rounded-2xl border border-amber-700/50 bg-amber-950/20">
            <FileBox size={44} className="text-amber-500" />
          </div>
        ) : mediaKind === "image" && mediaUrl ? (
          <img
            src={mediaUrl}
            alt={file.name}
            className="max-h-full max-w-full rounded-lg object-contain shadow-lg"
          />
        ) : mediaKind === "video" && mediaUrl ? (
          <video src={mediaUrl} controls className="max-h-full max-w-full rounded-lg shadow-lg" />
        ) : mediaKind === "audio" && mediaUrl ? (
          <audio src={mediaUrl} controls className="w-80 max-w-full" />
        ) : (
          <div className="flex size-28 items-center justify-center rounded-2xl border border-slate-700 bg-slate-900">
            <FileBox size={44} className="text-slate-500" />
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-sm font-medium text-slate-100">{file.name}</p>
        <p className="text-xs text-slate-500">
          {isAwaitingSharedAsset
            ? "Shared asset unavailable or still loading"
            : `${mimeType} · ${byteSize}`}
        </p>
        <p className="max-w-sm text-xs text-slate-500">
          Binary asset stored in this workspace. Reference it from your code with
          <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
            /{file.path}
          </code>
        </p>
      </div>

      {isAwaitingSharedAsset ? (
        <button
          type="button"
          onClick={() => {
            setRetryVersion((version) => version + 1);
            collaboration?.retryAssets();
          }}
          className="inline-flex items-center gap-2 rounded-md border border-amber-700/60 px-3 py-1.5 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-950/40"
        >
          <RefreshCw size={14} />
          Retry asset
        </button>
      ) : mediaUrl ? (
        <a
          href={mediaUrl}
          download={file.name}
          className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 transition-colors hover:bg-slate-800"
        >
          <Download size={14} />
          Download
        </a>
      ) : null}
    </div>
  );
};

export default BinaryFilePreview;
