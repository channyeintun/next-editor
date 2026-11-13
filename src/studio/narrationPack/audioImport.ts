import {
  getCachedDialogWav,
  hasCachedDialogWav,
  isDialogCacheAvailable,
  putCachedDialogWav,
} from "../tts/dialogCache";
import { prepareModalVoxCpm2Take } from "../tts/modalVoxCpm2Synth";
import { MODAL_VOXCPM2_BURMESE_PROFILE } from "../tts/profiles";
import { validateDialogWav } from "../tts/wav";
import { decodeFlacToWavPcm16 } from "./flac";
import { readZipDirectory, readZipEntry, type ZipDirectoryEntry } from "./zipDirectory";

/**
 * Offline narration, the import half: the takes a notebook synthesized from a
 * request pack (requestPack.ts), filed into the dialog cache under the hashes
 * the pack gave them. A take is named `<request hash>.flac` (or `.wav`); the
 * notebook writes them in zip parts, and a folder downloaded from Google Drive
 * arrives as a zip of those zips, so a zip is read one level into its zips.
 *
 * Every take is checked the way a render checks a cached one before it is
 * kept: a take the render would throw away would otherwise be synthesized
 * again by the hosted voice, at its price, without a word.
 */

const SAMPLE_RATE = MODAL_VOXCPM2_BURMESE_PROFILE.sampleRate;

/** `<64 hex>.flac` or `.wav`: the request hash is the take's name. */
const TAKE_NAME = /^([0-9a-f]{64})\.(flac|wav)$/;
const ZIP_NAME = /\.zip$/i;

/** VoxCPM2's longest dialog is a few minutes of speech: under 40 MB as a WAV. */
const MAX_TAKE_BYTES = 64 * 1024 * 1024;
/** One part the notebook writes is tens of megabytes. */
const MAX_INNER_ZIP_BYTES = 512 * 1024 * 1024;

export interface NarrationAudioImport {
  /** Takes filed into the dialog cache. */
  imported: number;
  /** Takes this browser already kept and a render can use; the kept take stays. */
  alreadyCached: number;
  /** Files that are not takes (a manifest, a zip inside a zip inside a zip). */
  ignored: number;
  /** Takes a render could not use, with the reason. */
  unusable: { name: string; reason: string }[];
  /** Why the browser keeps no takes (storage missing, full or blocked); the import ended there. */
  storageFailure: string | null;
}

export interface NarrationAudioImportOptions {
  /** Told after each take that is filed or found already kept. */
  onProgress?: (takes: number) => void;
  /** The FLAC decoder; tests replace the browser's. */
  decodeFlac?: typeof decodeFlacToWavPcm16;
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The metadata files macOS adds beside each file it zips (`._name`, or a
 * `__MACOSX` folder of them): named like the file, but not it.
 */
function isMacMetadata(path: string): boolean {
  return baseNameOf(path).startsWith("._") || /(^|\/)__MACOSX\//.test(path);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Whether a render could use this take: prepared, then validated, as it reads a cached one. */
function usableTake(wav: Uint8Array): void {
  validateDialogWav(prepareModalVoxCpm2Take(wav), SAMPLE_RATE);
}

/**
 * File the takes in these files (zips of takes, zips of those zips, or takes
 * themselves) into the dialog cache. Never throws for a bad take or a bad zip:
 * each is reported and the import goes on with the next. It ends early only
 * when the browser keeps no takes.
 */
export async function importNarrationAudio(
  files: readonly File[],
  { onProgress, decodeFlac = decodeFlacToWavPcm16 }: NarrationAudioImportOptions = {},
): Promise<NarrationAudioImport> {
  const result: NarrationAudioImport = {
    imported: 0,
    alreadyCached: 0,
    ignored: 0,
    unusable: [],
    storageFailure: null,
  };
  // Without Cache storage a write does nothing and reports nothing: every take
  // would count as imported while none was kept.
  if (!isDialogCacheAvailable()) {
    result.storageFailure = "Cache storage is not available in this page";
    return result;
  }
  const onUnavailable = (reason: string) => {
    result.storageFailure ??= reason;
  };
  const reportProgress = () => onProgress?.(result.imported + result.alreadyCached);

  /** Whether the cache keeps a take for this request that a render can use. */
  const keepsUsableTake = async (requestHash: string): Promise<boolean> => {
    if (!(await hasCachedDialogWav(requestHash, onUnavailable))) return false;
    const kept = await getCachedDialogWav(requestHash, onUnavailable);
    if (!kept) return false;
    try {
      usableTake(kept.wav);
      return true;
    } catch {
      // A render would evict this take and ask the hosted voice for another;
      // the imported one replaces it instead.
      return false;
    }
  };

  const importTake = async (name: string, bytes: Uint8Array): Promise<void> => {
    const match = TAKE_NAME.exec(name);
    if (!match) {
      result.ignored += 1;
      return;
    }
    const [, requestHash, kind] = match;
    if (await keepsUsableTake(requestHash)) {
      result.alreadyCached += 1;
      reportProgress();
      return;
    }
    if (result.storageFailure) return;
    let wav: Uint8Array;
    try {
      wav = kind === "flac" ? await decodeFlac(bytes, SAMPLE_RATE) : bytes;
      usableTake(wav);
    } catch (error) {
      result.unusable.push({ name, reason: reasonOf(error) });
      return;
    }
    await putCachedDialogWav(requestHash, { wav, hitFrameCap: false }, onUnavailable);
    if (!result.storageFailure) {
      result.imported += 1;
      reportProgress();
    }
  };

  /** What an entry is to the import, or null for one it passes over. */
  const wanted = (entry: ZipDirectoryEntry, nested: boolean): "take" | "zip" | null => {
    if (entry.name.endsWith("/")) return null;
    if (!isMacMetadata(entry.name)) {
      if (TAKE_NAME.test(baseNameOf(entry.name))) return "take";
      // A part inside a downloaded folder's zip is opened; a zip inside a part is not.
      if (!nested && ZIP_NAME.test(entry.name)) return "zip";
    }
    result.ignored += 1;
    return null;
  };

  const importZip = async (file: Blob, name: string, nested: boolean): Promise<void> => {
    let entries: ZipDirectoryEntry[];
    try {
      entries = await readZipDirectory(file);
    } catch (error) {
      result.unusable.push({ name, reason: `not a readable zip (${reasonOf(error)})` });
      return;
    }
    for (const entry of entries) {
      if (result.storageFailure) return;
      const kind = wanted(entry, nested);
      if (!kind) continue;
      const limit = kind === "zip" ? MAX_INNER_ZIP_BYTES : MAX_TAKE_BYTES;
      if (entry.size > limit) {
        result.unusable.push({ name: entry.name, reason: `larger than ${megabytes(limit)}` });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readZipEntry(file, entry);
      } catch (error) {
        result.unusable.push({ name: entry.name, reason: reasonOf(error) });
        continue;
      }
      if (kind === "zip") {
        await importZip(new Blob([bytes as Uint8Array<ArrayBuffer>]), entry.name, true);
      } else {
        await importTake(baseNameOf(entry.name), bytes);
      }
    }
  };

  for (const file of files) {
    if (result.storageFailure) break;
    if (isMacMetadata(file.name)) {
      result.ignored += 1;
    } else if (ZIP_NAME.test(file.name)) {
      await importZip(file, file.name, false);
    } else if (file.size > MAX_TAKE_BYTES) {
      result.unusable.push({ name: file.name, reason: `larger than ${megabytes(MAX_TAKE_BYTES)}` });
    } else {
      await importTake(file.name, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return result;
}
