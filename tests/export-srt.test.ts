import {test} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {scenesToSrt, writeSubtitles} from "../scripts/export-srt";

test("offsets scene captions by the intro and falls back to the title", () => {
  const result = scenesToSrt({introSec: 2.6, scenes: [
    {startSec: 0, endSec: 1.125, caption: "Introducción", title: "One"},
    {startSec: 1.125, endSec: 58, caption: "", title: "Vídeo"},
  ]});
  assert.equal(result, "1\n00:00:02,600 --> 00:00:03,725\nIntroducción\n\n2\n00:00:03,725 --> 00:01:00,600\nVídeo\n");
});

test("wraps words into two-line cues and distributes time by text length", () => {
  const word = "x".repeat(20);
  const caption = Array(5).fill(word).join(" ");
  const result = scenesToSrt({introSec: 1, scenes: [{startSec: 0, endSec: 10.3, title: "", caption}]});
  assert.equal(result, [
    "1", "00:00:01,000 --> 00:00:09,300", word + " " + word, word + " " + word, "",
    "2", "00:00:09,300 --> 00:00:11,300", word, "",
  ].join("\n"));
});

test("both files preserve scene boundaries and Unicode in an unspaced caption", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctv-subs-"));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const text = "映".repeat(41) + "🎬" + "字".repeat(42) + "<&>";
  const files = writeSubtitles(dir, {introSec: 1, scenes: [{startSec: 0, endSec: 0.087, caption: "", title: text}]});
  const srt = fs.readFileSync(files.srt, "utf8");
  const vtt = fs.readFileSync(files.vtt, "utf8");
  assert.equal(srt, `1\n00:00:01,000 --> 00:00:01,084\n${"映".repeat(41)}🎬\n${"字".repeat(42)}\n\n2\n00:00:01,084 --> 00:00:01,087\n<&>\n`);
  assert.equal(vtt, "WEBVTT\n\n" + srt.replace(/^\d+\n/gm, "").replace(/(\d{2}),(\d{3})/g, "$1.$2").replace("<&>", "&lt;&amp;&gt;"));
});
