export interface SlideBackgroundPreset {
  id: string;
  label: string;
  imagePath: string;
}

export const SLIDE_BACKGROUND_PRESETS: SlideBackgroundPreset[] = [
  { id: "texture-1", label: "Texture 1", imagePath: "/texture-1.jpeg" },
  { id: "texture-2", label: "Texture 2", imagePath: "/texture-2.jpeg" },
];

/**
 * Resolves a slide's stored `background` value to an image source.
 * The value is either a known preset id, or a custom image source (a data
 * URL from an uploaded image) stored directly on the slide.
 */
export function getSlideBackgroundImage(id?: string): string | undefined {
  if (!id || id === "none") return undefined;
  const preset = SLIDE_BACKGROUND_PRESETS.find((preset) => preset.id === id);
  return preset ? preset.imagePath : id;
}

export function isCustomSlideBackground(id?: string): boolean {
  return !!id && id !== "none" && !SLIDE_BACKGROUND_PRESETS.some((preset) => preset.id === id);
}

const MAX_CUSTOM_IMAGE_DIMENSION = 1920;
const CUSTOM_IMAGE_QUALITY = 0.8;
const MAX_CUSTOM_IMAGE_BYTES = 1.5 * 1024 * 1024;

export class CustomBackgroundError extends Error {}

/**
 * Reads an uploaded image file, downscales/re-encodes it client-side (there's
 * no backend — the result is stored inline as a data URL in localStorage
 * alongside the rest of the slide deck), and returns the data URL to use as
 * `Slide.background`.
 */
export async function readCustomBackgroundImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new CustomBackgroundError("Please choose an image file.");
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new CustomBackgroundError("Couldn't read that image."));
      img.src = objectUrl;
    });

    const scale = Math.min(1, MAX_CUSTOM_IMAGE_DIMENSION / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new CustomBackgroundError("Couldn't process that image.");
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL("image/jpeg", CUSTOM_IMAGE_QUALITY);
    const approxBytes = (dataUrl.length * 3) / 4;
    if (approxBytes > MAX_CUSTOM_IMAGE_BYTES) {
      throw new CustomBackgroundError("Couldn't use that image — try a smaller file.");
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
