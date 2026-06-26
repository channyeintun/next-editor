import type { CaptionCue } from "../core/src/types";

function parseTimestampMs(raw: string): number {
  const parts = raw.trim().split(":");
  let hours = 0;
  let minutes = 0;
  let rest: string;

  if (parts.length === 3) {
    hours = parseInt(parts[0], 10);
    minutes = parseInt(parts[1], 10);
    rest = parts[2];
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0], 10);
    rest = parts[1];
  } else {
    return NaN;
  }

  const [secPart, msPart] = rest.includes(",") ? rest.split(",") : rest.split(".");
  const seconds = parseInt(secPart, 10);
  const ms = parseInt((msPart ?? "0").padEnd(3, "0").slice(0, 3), 10);

  return (hours * 3600 + minutes * 60 + seconds) * 1000 + ms;
}

const TIMESTAMP_LINE =
  /^\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{2,3}/;

function stripVttTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function normalizeCues(cues: CaptionCue[]): CaptionCue[] {
  return cues
    .filter((c) => c.start >= 0 && c.end > c.start && c.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
}

export function parseVtt(text: string): CaptionCue[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cues: CaptionCue[] = [];
  let i = 0;

  if (lines[0]?.trim().startsWith("WEBVTT")) {
    i = 1;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith("NOTE") || line.trim().startsWith("STYLE")) {
      i++;
      while (i < lines.length && lines[i].trim() !== "") {
        i++;
      }
      i++;
      continue;
    }

    if (!TIMESTAMP_LINE.test(line)) {
      i++;
      continue;
    }

    const arrowIdx = line.indexOf("-->");
    const startStr = line.slice(0, arrowIdx).trim();
    const endAndSettings = line.slice(arrowIdx + 3).trim();
    const endStr = endAndSettings.split(/\s+/)[0];
    const start = parseTimestampMs(startStr);
    const end = parseTimestampMs(endStr);
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }

    const rawText = textLines.join("\n");
    const cleanText = stripVttTags(rawText).trim();

    if (!isNaN(start) && !isNaN(end) && cleanText) {
      cues.push({ start, end, text: cleanText });
    }

    i++;
  }

  return normalizeCues(cues);
}

export function parseSrt(text: string): CaptionCue[] {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n\s*\n/);
  const cues: CaptionCue[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let timestampLineIdx = -1;

    for (let j = 0; j < lines.length; j++) {
      if (TIMESTAMP_LINE.test(lines[j])) {
        timestampLineIdx = j;
        break;
      }
    }

    if (timestampLineIdx === -1) continue;

    const tsLine = lines[timestampLineIdx];
    const arrowIdx = tsLine.indexOf("-->");
    const startStr = tsLine.slice(0, arrowIdx).trim();
    const endStr = tsLine
      .slice(arrowIdx + 3)
      .trim()
      .split(/\s+/)[0];
    const start = parseTimestampMs(startStr);
    const end = parseTimestampMs(endStr);

    const textLines = lines.slice(timestampLineIdx + 1);
    const cleanText = textLines
      .map((l) => stripVttTags(l))
      .join("\n")
      .trim();

    if (!isNaN(start) && !isNaN(end) && cleanText) {
      cues.push({ start, end, text: cleanText });
    }
  }

  return normalizeCues(cues);
}

export function detectAndParse(filename: string, text: string): CaptionCue[] {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "srt") return parseSrt(text);
  if (ext === "vtt") return parseVtt(text);
  if (text.trim().startsWith("WEBVTT")) return parseVtt(text);
  if (/^\d+\s*\n\d{2}:\d{2}/.test(text.trim())) return parseSrt(text);
  return parseVtt(text);
}

export function inferLanguageFromFilename(filename: string): string | null {
  const base = filename.replace(/\.[^.]+$/, "");
  const match = base.match(/\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/);
  return match ? match[1].toLowerCase() : null;
}
