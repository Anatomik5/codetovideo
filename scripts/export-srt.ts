import fs from "node:fs";
import path from "node:path";

interface Scene {
  startSec: number;
  endSec: number;
  caption: string;
  title: string;
}

type Manifest = { introSec: number; scenes: Scene[] };
type Cue = { start: number; end: number; text: string };

function wrapLines(text: string): string[] {
  const lines: string[] = [];
  let line: string[] = [];
  for (const word of text.split(" ")) {
    const chars = Array.from(word);
    if (line.length && line.length + 1 + chars.length <= 42) {
      line.push(" ", ...chars);
      continue;
    }
    if (line.length) lines.push(line.join(""));
    let offset = 0;
    while (chars.length - offset > 42) {
      lines.push(chars.slice(offset, offset + 42).join(""));
      offset += 42;
    }
    line = chars.slice(offset);
  }
  if (line.length) lines.push(line.join(""));
  return lines;
}

function timestamp(ms: number, separator: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function sceneCues({introSec, scenes}: Manifest): Cue[] {
  if (!Number.isFinite(introSec) || introSec < 0) throw new Error("Invalid intro duration");
  const cues: Cue[] = [];
  for (const scene of scenes) {
    const text = (scene.caption?.trim() || scene.title?.trim() || "").replace(/\s+/g, " ");
    if (!text) continue;
    const start = Math.round((introSec + scene.startSec) * 1000);
    const end = Math.round((introSec + scene.endSec) * 1000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || scene.startSec < 0 || end <= start) {
      throw new Error(`Invalid scene timing for "${text}"`);
    }
    const lines = wrapLines(text);
    const parts: string[] = [];
    for (let i = 0; i < lines.length; i += 2) parts.push(lines.slice(i, i + 2).join("\n"));
    if (end - start < parts.length) throw new Error("Scene is too short for millisecond subtitle timings");
    const weights = parts.map(part => Array.from(part).length);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let used = 0;
    let from = start;
    for (const [i, part] of parts.entries()) {
      used += weights[i];
      // Reserve at least one millisecond for each remaining cue.
      const ideal = start + Math.round((end - start) * (used / total));
      const to = Math.min(end - (parts.length - i - 1), Math.max(from + 1, ideal));
      cues.push({ start: from, end: to, text: part });
      from = to;
    }
  }
  return cues;
}

function serialize(cues: Cue[], format: "srt" | "vtt"): string {
  const vtt = format === "vtt";
  const sep = vtt ? "." : ",";
  const blocks = cues.map((cue, i) => {
    const text = vtt ? cue.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : cue.text;
    const id = vtt ? "" : `${i + 1}\n`;
    return `${id}${timestamp(cue.start, sep)} --> ${timestamp(cue.end, sep)}\n${text}\n`;
  });
  return (vtt ? "WEBVTT\n\n" : "") + blocks.join("\n");
}

export function scenesToSrt(manifest: Manifest): string {
  return serialize(sceneCues(manifest), "srt");
}

/** Generate just the file requested by the desktop Save dialog for a legacy session. */
export function saveSubtitle(manifestPath: string, format: "srt" | "vtt", target: string): void {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  fs.writeFileSync(target, serialize(sceneCues(manifest), format), "utf8");
}

export function writeSubtitles(dir: string, manifest: Manifest) {
  const cues = sceneCues(manifest);
  const paths = { srt: path.join(dir, "final.srt"), vtt: path.join(dir, "final.vtt") };
  for (const format of ["srt", "vtt"] as const) {
    fs.writeFileSync(paths[format], serialize(cues, format), "utf8");
  }
  return paths;
}

export function writeSrtForManifest(manifestPath: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  return writeSubtitles(path.dirname(manifestPath), manifest).srt;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npm run subtitles -- path/to/manifest.json");
  console.log(writeSrtForManifest(file));
}
