// Rebuilds docs/architecture.drawio, docs/architecture.svg and docs/architecture.png from one node/edge description.
//   node scripts/build-diagram.cjs
// The .drawio file can also be edited by hand in https://app.diagrams.net (then export PNG yourself).
const fs = require("fs");
const path = require("path");
const DOCS = path.resolve(__dirname, "..", "docs");

const C = {
  input: { fill: "#dbeafe", stroke: "#2563eb" },
  llm: { fill: "#ffedd5", stroke: "#ea580c" },
  tool: { fill: "#dcfce7", stroke: "#16a34a" },
  store: { fill: "#ede9fe", stroke: "#7c3aed" },
  out: { fill: "#fef9c3", stroke: "#ca8a04" },
};
const W = 270, H = 100;
const N = [
  ["app", 40, 40, "Desktop app / CLI\nprompt · repo or URL · uploads\nformat · quality · background", "input"],
  ["health", 700, 40, "LLM Health & Keep-Alive\nauto-start `ollama serve`, warm-up,\nretries, one num_ctx", "tool"],
  ["llm", 1060, 40, "Your LLM (any OpenAI-compatible)\nlocal Ollama qwen3.5:4b, Gemini,\nOpenRouter, Groq ...", "llm"],

  ["s1", 40, 215, "1 · Repo Study\nfile tree, README, manifests,\nlaunch scripts", "tool"],
  ["s2", 380, 215, "2 · AI Director (LLM)\nscenes, titles, captions, pacing,\npalette, language, motif", "llm"],
  ["s3", 720, 215, "3 · Process Executor\nsafe launch command, no shell,\nport discovery, tree cleanup", "tool"],
  ["s4", 1060, 215, "4 · Scene-aware Browser Agent\nPlaywright, DOM/ARIA; LLM reads\nbutton labels; real hi-res capture", "tool"],

  ["svg", 380, 390, "Backdrop (demo format)\nauto · model draws · model picks\nneutral animated motifs", "llm"],
  ["clips", 1060, 390, "Real screen recording\nsliced at clicks into\nclips/scene_NN.mp4", "tool"],

  ["session", 1060, 565, "5 · Session store (out/sessions/<id>/)\nmanifest.json · clips/ · props.json", "store"],
  ["compose", 720, 565, "6 · Compose (FFmpeg + Remotion)\nDemo or Promo format\n480p to 4K, no audio", "tool"],
  ["final", 380, 565, "Final video\nsessions/<id>/final.mp4\nout/demo.mp4", "out"],

  ["edit", 1060, 760, "Edit request\n--edit-scene N --edit-prompt\n(or Edit tab in the app)", "input"],
  ["classify", 720, 760, "LLM classifies the edit\ntext/style or re-shoot", "llm"],
  ["modeA", 380, 760, "Mode A · text / style / backdrop\npatch manifest, partial render,\nrest copied with ffmpeg -c copy", "tool"],
  ["modeB", 720, 935, "Mode B · re-shoot one scene\nreplay earlier steps headlessly,\nrecord only that clip", "tool"],
];
const E = [
  ["app", "s1", "prompt + path"],
  ["s1", "s2", "repo study"],
  ["s2", "s3", "plan"],
  ["s3", "s4", "app URL"],
  ["s2", "svg", "backdrop brief"],
  ["s4", "clips", "recording"],
  ["clips", "session", "save"],
  ["session", "compose", "clips"],
  ["compose", "final", ""],
  ["session", "edit", "edit"],
  ["edit", "classify", ""],
  ["classify", "modeA", "text / style"],
  ["classify", "modeB", "browser change"],
  ["modeA", "compose", "re-render"],
  ["modeB", "session", "new clip"],
  ["health", "llm", "pre-flight"],
  ["llm", "s2", "plan JSON"],
  ["llm", "s4", "button roles, steps"],
  ["svg", "session", "backdrop SVG"],
];
const byId = Object.fromEntries(N.map((n) => [n[0], { id: n[0], x: n[1], y: n[2], text: n[3], kind: n[4] }]));
const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---- drawio ----
let cells = '<mxCell id="0"/><mxCell id="1" parent="0"/>';
for (const n of Object.values(byId)) {
  const c = C[n.kind];
  const label = esc(n.text).replace(/\n/g, "&lt;br&gt;");
  cells += `<mxCell id="${n.id}" value="${label}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${c.fill};strokeColor=${c.stroke};strokeWidth=2;fontSize=13;align=center;" vertex="1" parent="1"><mxGeometry x="${n.x}" y="${n.y}" width="${W}" height="${H}" as="geometry"/></mxCell>`;
}
E.forEach(([a, b, l], i) => {
  cells += `<mxCell id="e${i}" value="${esc(l)}" style="endArrow=block;html=1;rounded=0;strokeWidth=2;fontSize=11;edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${a}" target="${b}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
});
fs.writeFileSync(path.join(DOCS, "architecture.drawio"), `<mxfile host="app.diagrams.net"><diagram id="ctv" name="CTV architecture"><mxGraphModel dx="1400" dy="1000" grid="1" gridSize="10" page="1" pageWidth="1400" pageHeight="1160"><root>${cells}</root></mxGraphModel></diagram></mxfile>`);

// ---- svg ----
const edgePoint = (a, b) => {
  const ax = a.x + W / 2, ay = a.y + H / 2, bx = b.x + W / 2, by = b.y + H / 2;
  const dx = bx - ax, dy = by - ay;
  const sx = dx === 0 ? Infinity : W / 2 / Math.abs(dx), sy = dy === 0 ? Infinity : H / 2 / Math.abs(dy);
  const t = Math.min(sx, sy);
  return [ax + dx * t, ay + dy * t];
};
const HEIGHT = 1130;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="${HEIGHT}" viewBox="0 0 1400 ${HEIGHT}" font-family="Segoe UI, Arial, sans-serif">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#334155"/></marker></defs>
<rect width="1400" height="${HEIGHT}" fill="#ffffff"/>
<text x="40" y="26" font-size="20" font-weight="700" fill="#0f172a">CTV · how it works: the AI is the director, the program is real</text>`;
E.forEach(([a, b, l]) => {
  const A = byId[a], B = byId[b];
  const [x1, y1] = edgePoint(A, B), [x2, y2] = edgePoint(B, A);
  svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#334155" stroke-width="2" marker-end="url(#ar)"/>`;
  if (l) {
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    svg += `<rect x="${mx - l.length * 3.4 - 4}" y="${my - 18}" width="${l.length * 6.8 + 8}" height="16" fill="#ffffff" opacity="0.92"/><text x="${mx}" y="${my - 6}" font-size="11" text-anchor="middle" fill="#334155">${esc(l)}</text>`;
  }
});
for (const n of Object.values(byId)) {
  const c = C[n.kind];
  svg += `<rect x="${n.x}" y="${n.y}" width="${W}" height="${H}" rx="12" fill="${c.fill}" stroke="${c.stroke}" stroke-width="2"/>`;
  const lines = n.text.split("\n");
  const y0 = n.y + H / 2 - (lines.length - 1) * 8.5 - 2;
  lines.forEach((ln, i) => {
    svg += `<text x="${n.x + W / 2}" y="${y0 + i * 17 + 4}" font-size="${i === 0 ? 13.5 : 12}" font-weight="${i === 0 ? 700 : 400}" text-anchor="middle" fill="#0f172a">${esc(ln)}</text>`;
  });
}
const legend = [["input", "input / request"], ["llm", "LLM (director, classifier)"], ["tool", "real tools: Playwright · FFmpeg · Remotion"], ["store", "saved session"], ["out", "output"]];
legend.forEach(([k, t], i) => {
  svg += `<rect x="${40 + i * 270}" y="${HEIGHT - 40}" width="16" height="16" rx="4" fill="${C[k].fill}" stroke="${C[k].stroke}" stroke-width="2"/><text x="${64 + i * 270}" y="${HEIGHT - 27}" font-size="12" fill="#334155">${esc(t)}</text>`;
});
svg += "</svg>";
fs.writeFileSync(path.join(DOCS, "architecture.svg"), svg);

// ---- png (needs Playwright's Chromium, which `npm install` already downloads) ----
(async () => {
  const { chromium } = require("playwright");
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: HEIGHT }, deviceScaleFactor: 2 });
  await p.setContent(`<body style="margin:0">${svg}</body>`);
  await p.screenshot({ path: path.join(DOCS, "architecture.png") });
  await b.close();
  console.log("diagram written to docs/");
})();
