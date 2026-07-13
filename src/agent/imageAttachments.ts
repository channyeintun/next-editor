import type { ChatImage } from "../types/chat";

export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export function getClipboardImageFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  return itemFiles.length > 0
    ? itemFiles
    : Array.from(clipboardData.files).filter((file) => file.type.startsWith("image/"));
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image."));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the pasted image."));
    reader.readAsDataURL(file);
  });
}

function createImageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `image_${crypto.randomUUID()}`;
  }
  return `image_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export async function createChatImage(file: File): Promise<ChatImage> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Paste a PNG, JPEG, GIF, or WebP image.");
  }
  if (file.size > MAX_CHAT_IMAGE_BYTES) {
    throw new Error("Pasted images must be 5 MB or smaller.");
  }

  return {
    id: createImageId(),
    dataUrl: await readFileAsDataUrl(file),
    mimeType: file.type,
    ...(file.name ? { name: file.name } : {}),
  };
}
