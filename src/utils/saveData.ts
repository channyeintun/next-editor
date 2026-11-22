/**
 * Whether the viewer asked the browser to save data, where the browser says so. Nothing
 * that is only loaded ahead (a chunk, the start of a narration) is fetched then.
 */
export function prefersSavingData(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
}
