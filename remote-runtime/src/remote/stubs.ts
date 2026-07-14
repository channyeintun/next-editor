export { PreviewMessageType, isPreviewMessage } from "./previewMessages";

export const auth = {
  init: () => ({ status: "authorized" as const }),
  startAuthFlow: () => {},
  loggedIn: async () => {},
  logout: async () => {},
  on: () => () => {},
};

export function setupConnect(): void {}
export function configureAPIKey(): void {}

export async function reloadPreview(iframe: HTMLIFrameElement): Promise<void> {
  try {
    const url = new URL(iframe.src);
    url.searchParams.set("__remote_reload", Date.now().toString(36));
    iframe.src = url.toString();
  } catch {
    iframe.contentWindow?.location.reload();
  }
}
