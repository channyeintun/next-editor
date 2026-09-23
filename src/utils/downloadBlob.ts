// Long enough for any browser to have started reading the Blob behind the URL;
// until then revoking it can cancel the download. Keeping the mapping a few
// seconds longer only delays freeing a Blob the page is done with.
const REVOKE_DELAY_MS = 10_000;

/** Saves `blob` as a browser download named `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  // Attached for the click: some browsers ignore a click on a detached anchor.
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
