export interface SlideBackgroundPreset {
  id: string;
  label: string;
  imagePath: string;
}

export const SLIDE_BACKGROUND_PRESETS: SlideBackgroundPreset[] = [
  { id: "texture-1", label: "Texture 1", imagePath: "/texture-1.jpeg" },
  { id: "texture-2", label: "Texture 2", imagePath: "/texture-2.jpeg" },
];

export function getSlideBackgroundImage(id?: string): string | undefined {
  if (!id || id === "none") return undefined;
  return SLIDE_BACKGROUND_PRESETS.find((preset) => preset.id === id)?.imagePath;
}
