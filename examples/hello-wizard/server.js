// A tiny, dependency-free three-step web app for trying CTV without a project of your own:
//   1. upload a file  ->  2. wait for a (fake) analysis  ->  3. review the result and export.
// Run it directly (`node examples/hello-wizard/server.js`) or let CTV launch it:
//   npx ts-node scripts/demo-pipeline.ts --file examples/hello-wizard/server.js --upload examples/hello-wizard/sample.csv
const http = require("http");

const PORT = Number(process.env.PORT) || 3000;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Hello Wizard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font: 16px/1.5 system-ui, sans-serif; background: #f5f7fb; color: #172033; margin: 0; }
  header { background: #fff; border-bottom: 1px solid #e3e8f0; padding: 14px 28px; font-weight: 800; }
  main { max-width: 760px; margin: 36px auto; padding: 0 20px; }
  .card { background: #fff; border: 1px solid #e3e8f0; border-radius: 14px; padding: 26px; box-shadow: 0 6px 24px rgba(20,40,90,.06); }
  .steps { display: flex; gap: 10px; margin-bottom: 22px; }
  .steps span { flex: 1; text-align: center; padding: 8px; border-radius: 999px; background: #e9eef8; font-size: 14px; }
  .steps span.on { background: #2563eb; color: #fff; }
  .row { display: flex; justify-content: space-between; margin-top: 26px; }
  button { font: inherit; border-radius: 10px; padding: 10px 20px; cursor: pointer; border: 1px solid #2563eb; }
  button.primary { background: #2563eb; color: #fff; }
  button.ghost { background: transparent; color: #2563eb; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  progress { width: 100%; height: 14px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid #edf0f6; }
</style>
</head>
<body>
<header>Hello Wizard</header>
<main>
  <div class="card">
    <div class="steps"><span id="s1" class="on">1 Upload</span><span id="s2">2 Analyze</span><span id="s3">3 Export</span></div>

    <section id="step1">
      <h2>Upload a file</h2>
      <p>Any small file works; the analysis is simulated.</p>
      <input id="file" type="file" required />
      <div class="row"><span></span><button id="go" class="primary" disabled>Analyze</button></div>
    </section>

    <section id="step2" hidden>
      <h2>Analyzing…</h2>
      <progress id="bar" role="progressbar" value="0" max="100"></progress>
      <p id="status">Reading the file</p>
      <div class="row"><button id="back2" class="ghost">Back</button><button id="next2" class="primary" disabled>Continue to results</button></div>
    </section>

    <section id="step3" hidden>
      <h2>Results</h2>
      <table>
        <tr><th>Check</th><th>Result</th></tr>
        <tr><td>Structure</td><td>OK</td></tr><tr><td>Totals</td><td>OK</td></tr>
        <tr><td>Duplicates</td><td>2 found</td></tr><tr><td>Formatting</td><td>OK</td></tr>
        <tr><td>Units</td><td>1 warning</td></tr><tr><td>Dates</td><td>OK</td></tr>
        <tr><td>Names</td><td>OK</td></tr><tr><td>Limits</td><td>OK</td></tr>
        <tr><td>Notes</td><td>3 suggestions</td></tr><tr><td>Score</td><td>8.4 / 10</td></tr>
      </table>
      <div class="row"><button id="back3" class="ghost">Back</button><button id="export" class="primary">Export report</button></div>
      <p id="done" hidden><strong>Report exported.</strong></p>
    </section>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const show = (n) => {
    for (const i of [1, 2, 3]) { $("step" + i).hidden = i !== n; $("s" + i).classList.toggle("on", i === n); }
  };
  $("file").addEventListener("change", () => { $("go").disabled = !$("file").files.length; });
  $("go").addEventListener("click", () => {
    show(2); $("next2").disabled = true; let v = 0; $("bar").value = 0;
    const t = setInterval(() => {
      v += 10; $("bar").value = v; $("status").textContent = v < 100 ? "Checking rows…" : "Done";
      if (v >= 100) { clearInterval(t); $("next2").disabled = false; }
    }, 350);
  });
  $("back2").addEventListener("click", () => show(1));
  $("next2").addEventListener("click", () => show(3));
  $("back3").addEventListener("click", () => show(2));
  $("export").addEventListener("click", () => { $("done").hidden = false; });
</script>
</body>
</html>`;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`Hello Wizard running at http://localhost:${PORT}`));
