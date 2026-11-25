import fs from "node:fs";
import path from "node:path";

interface Scene {
  startSec: number;
  endSec: number;
  caption: string;
  title: string;
}

function timestamp(ms: number): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function scenesToSrt({introSec, scenes}: {introSec: number; scenes: Scene[]}): string {
  if (!Number.isFinite(introSec) || introSec < 0) throw new Error("Invalid intro duration");
  const cues: string[] = [];
  for (const scene of scenes) {
    const text = (scene.caption?.trim() || scene.title?.trim() || "").replace(/\s+/g, " ");
    if (!text) continue;
    const start = Math.round((introSec + scene.startSec) * 1000);
    const end = Math.round((introSec + scene.endSec) * 1000);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || scene.startSec < 0 || end <= start) {
      throw new Error(`Invalid scene timing for "${text}"`);
    }
    cues.push(`${cues.length + 1}\n${timestamp(start)} --> ${timestamp(end)}\n${text}\n`);
  }
  return cues.join("\n");
}

/** Writes `final.srt` next to the manifest (inside the session folder, beside `final.mp4`) and returns its path. */
export function writeSrtForManifest(manifestPath: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const output = path.join(path.dirname(manifestPath), "final.srt");
  fs.writeFileSync(output, scenesToSrt(manifest), "utf8");
  return output;
}

if (require.main === module) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: npm run subtitles -- path/to/manifest.json");
  console.log(writeSrtForManifest(file));
}
