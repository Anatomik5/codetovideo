import { saveSubtitle } from "./export-srt";

const [manifest, format, target] = process.argv.slice(2);
if (!manifest || !target || (format !== "srt" && format !== "vtt")) {
  throw new Error("Expected a manifest, subtitle format and destination");
}
saveSubtitle(manifest, format, target);
