// Runs the same CTV scenario with several models and compares them: speed, plan text, navigation, background.
//
//   node scripts/bench-models.cjs --models qwen3.5:4b,gemma4:e2b,gemma4:e4b
//   node scripts/bench-models.cjs --models my-model --file path/to/app --upload data.xlsx --prompt "..."
//
// Defaults to the bundled examples/hello-wizard app. Runs record only (--no-render) and use --backdrop generate,
// so the model itself draws the background. Results go to out/bench/<timestamp>/: one log and one manifest per
// model, results.json and backdrops.png (the backgrounds side by side).
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SESSIONS = path.join(ROOT, "out", "sessions");

function parseArgs(argv) {
  const o = {
    models: [],
    file: path.join(ROOT, "examples", "hello-wizard", "server.js"),
    uploads: [],
    prompt: "Show the full workflow from upload to export. All titles and captions in English. Dark neon style with glowing lines at the edges.",
    baseUrl: "http://localhost:11434/v1",
  };
  let uploadsGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--models") o.models = String(next()).split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--file") o.file = path.resolve(next());
    else if (a === "--upload") { uploadsGiven = true; o.uploads.push(path.resolve(next())); }
    else if (a === "--prompt") o.prompt = next();
    else if (a === "--base-url") o.baseUrl = next();
  }
  if (!uploadsGiven && o.file.includes("hello-wizard")) o.uploads = [path.join(ROOT, "examples", "hello-wizard", "sample.csv")];
  return o;
}

const safe = (m) => m.replace(/[^a-z0-9.]+/gi, "_");
const listSessions = () => (fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS) : []);

function runOne(o, model, outDir) {
  return new Promise((resolve) => {
    const before = new Set(listSessions());
    const log = fs.createWriteStream(path.join(outDir, `${safe(model)}.log`));
    const t0 = Date.now();
    const args = [
      path.join(ROOT, "node_modules", "ts-node", "dist", "bin.js"), "scripts/demo-pipeline.ts",
      "--file", o.file, ...o.uploads.flatMap((u) => ["--upload", u]),
      "--model", model, "--base-url", o.baseUrl,
      "--backdrop", "generate", "--no-render", "--prompt", o.prompt,
      "--out", path.join("out", "bench", `${safe(model)}.mp4`),
    ];
    const c = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, "");
        buf = buf.slice(i + 1);
        log.write(`${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} ${line}\n`);
      }
    };
    c.stdout.on("data", onData);
    c.stderr.on("data", onData);
    c.on("exit", (code) => {
      log.end();
      const created = listSessions().filter((s) => !before.has(s)).sort();
      if (created.length) fs.copyFileSync(path.join(SESSIONS, created.pop(), "manifest.json"), path.join(outDir, `${safe(model)}.manifest.json`));
      console.log(`${model}: exit ${code}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      resolve();
    });
  });
}

function analyze(model, outDir) {
  const logFile = path.join(outDir, `${safe(model)}.log`);
  const lines = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => ({ t: parseFloat(l.slice(0, 7)), s: l.slice(8) }))
    : [];
  const t = (re) => lines.find((l) => re.test(l.s))?.t ?? null;
  const has = (re) => lines.some((l) => re.test(l.s));
  const planStart = t(/\[Repo Study\]/), svgStart = t(/\[SvgArtist\] Generating vector backdrop/), planned = t(/\[AI Architect\] Planned/);
  const recStart = t(/\[Playwright\] Recording live UI/), recEnd = t(/\[FFmpeg\] Encoding continuous capture/);
  const mf = path.join(outDir, `${safe(model)}.manifest.json`);
  const m = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, "utf8")) : null;
  const diff = (a, b) => (a != null && b != null ? +(b - a).toFixed(1) : null);
  return {
    model,
    ok: !!m,
    seconds: { total: lines.length ? lines[lines.length - 1].t : null, plan: diff(planStart, svgStart), background: diff(svgStart, planned), recording: diff(recStart, recEnd) },
    background: has(/Model-drawn backdrop kept|Backdrop validated/) ? "drawn by the model" : has(/too sparse at the edges/) ? "model drawing + motif" : has(/Using procedural|did not return a valid SVG/) ? "motif fallback (no usable drawing)" : "unknown",
    steps: lines.filter((l) => /\[Playwright\] Step \d+:/.test(l.s)).length,
    stopReason: lines.find((l) => /\[Result\] stopReason:/.test(l.s))?.s.replace("[Result] stopReason: ", "") || null,
    fatal: lines.filter((l) => /Fatal error/.test(l.s)).map((l) => l.s.slice(0, 200)),
    plan: m ? { videoTitle: m.videoTitle, introLine: m.introLine, outroLine: m.outroLine, pacing: m.pacing, scenes: m.scenes.map((s) => ({ title: s.title, caption: s.caption })) } : null,
    roles: lines.filter((l) => /\[Roles\]/.test(l.s)).map((l) => l.s.replace("[Roles] ", "")),
  };
}

async function backdropSheet(models, outDir, results) {
  const { chromium } = require("playwright");
  const cards = models.map((model) => {
    const f = path.join(outDir, `${safe(model)}.manifest.json`);
    const r = results.find((x) => x.model === model);
    if (!fs.existsSync(f)) return `<div class="c"><div class="v"></div><b>${model}</b><i>run failed</i></div>`;
    const a = JSON.parse(fs.readFileSync(f, "utf8")).artDirection;
    return `<div class="c"><div class="v" style="background:linear-gradient(135deg,${a.bgStart},${a.bgEnd})">${a.backdropSvg || ""}<div class="w"></div></div><b>${model}</b><i>${r.background} · ${r.seconds.background ?? "?"} s</i></div>`;
  });
  const html = `<html><body style="margin:0;background:#0b0f19;font-family:Segoe UI,Arial;color:#e8eefc">
  <style>.g{display:flex;gap:18px;padding:18px}.c{width:640px}.v{width:640px;height:360px;border-radius:10px;overflow:hidden;position:relative}
  .v svg{position:absolute;inset:0;width:100%;height:100%}.w{position:absolute;left:12%;top:14%;width:76%;height:72%;border:2px dashed rgba(255,255,255,.35);border-radius:8px}
  b{display:block;margin-top:8px;font-size:20px}i{color:#9fb0d0;font-style:normal}</style>
  <div class="g">${cards.join("")}</div></body></html>`;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 18 + models.length * 658, height: 440 } });
  await p.setContent(html);
  await p.screenshot({ path: path.join(outDir, "backdrops.png") });
  await b.close();
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.models.length) {
    console.error("Usage: node scripts/bench-models.cjs --models a,b,c [--file app] [--upload file]... [--prompt text] [--base-url url]");
    process.exit(1);
  }
  const outDir = path.join(ROOT, "out", "bench", new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(outDir, { recursive: true });
  for (const m of o.models) await runOne(o, m, outDir);
  const results = o.models.map((m) => analyze(m, outDir));
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await backdropSheet(o.models, outDir, results);
  for (const r of results) console.log(`${r.model}: ${JSON.stringify(r.seconds)} | background: ${r.background} | steps: ${r.steps} | ${r.stopReason || (r.ok ? "completed" : "failed")}`);
  console.log(`Results: ${outDir} (results.json, backdrops.png; the dashed box marks where the browser window covers the background)`);
})();
