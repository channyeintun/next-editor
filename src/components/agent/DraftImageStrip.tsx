import { X } from "lucide-react";
import type { ChatImage } from "../../types/chat";

/** Thumbnails of the images pasted into the message box; renders nothing without any. */
export default function DraftImageStrip({
  images,
  onRemove,
}: {
  images: ChatImage[];
  onRemove: (imageId: string) => void;
}) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-2 overflow-x-auto border-b border-slate-800/80 p-2">
      {images.map((image) => (
        <div key={image.id} className="group relative size-14 shrink-0">
          <img
            src={image.dataUrl}
            alt={image.name ?? "Pasted image"}
            className="size-full rounded border border-slate-700 object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(image.id)}
            className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full bg-slate-900 text-slate-300 shadow hover:bg-red-900 hover:text-red-100"
            aria-label={`Remove ${image.name ?? "pasted image"}`}
            title="Remove image"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
