import {test} from "node:test";
import assert from "node:assert/strict";
import {scenesToSrt} from "../scripts/export-srt";

test("offsets scene captions by the intro and falls back to the title", () => {
  const result = scenesToSrt({introSec: 2.6, scenes: [
    {startSec: 0, endSec: 1.125, caption: "Introducción", title: "One"},
    {startSec: 1.125, endSec: 58, caption: "", title: "Vídeo"},
  ]});
  assert.equal(result, "1\n00:00:02,600 --> 00:00:03,725\nIntroducción\n\n2\n00:00:03,725 --> 00:01:00,600\nVídeo\n");
});
