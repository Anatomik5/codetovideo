# Contributing to CTV

Thanks for helping! CTV is young and needs more eyes, more machines and more apps to try it on. You do not have to write code to help: a good bug report with a log is a real contribution.

## Ways to help (easiest first)

1. **Try it on your app and tell us what happened.** Open an issue with the *Run report* template (worked or not, model, OS, where the agent got stuck).
2. **Test on macOS / Linux.** The project is developed on Windows 11; other platforms are unverified.
3. **Pick something from [ROADMAP.md](ROADMAP.md).** Items marked 🙋 *help wanted* are well scoped.
4. **Improve the docs.** Typos, unclear steps, translations (see below).
5. **Write tests.** `tests/` only covers pure helpers so far.

## Development setup

```bash
git clone https://github.com/Anatomik5/codetovideo.git
cd codetovideo
npm install        # also downloads Chromium for Playwright
npm run typecheck  # tsc --noEmit
npm test           # unit tests (Node 22+, the test script uses a glob)
npm run app        # desktop app
```

Quick smoke test without rendering and without a project of your own:

```bash
npx ts-node scripts/demo-pipeline.ts \
  --file examples/hello-wizard/server.js \
  --upload examples/hello-wizard/sample.csv \
  --model "qwen3.5:4b" --base-url "http://localhost:11434/v1" \
  --prompt "Show the workflow" --max-steps 3 --no-render
```

## Ground rules (they are the point of the project)

1. **No hardcoding.** Never add checks for specific URLs, button texts, languages, frameworks or business domains. Navigation uses DOM / ARIA / geometry; the *meaning* of a label is decided by the connected LLM. If you are tempted to add a word list, open an issue instead.
2. **No paid services.** Only the user's own LLM endpoint (or a keyless local model) and free local tools.
3. **Real pixels only.** The AI directs; everything on screen comes from the real recording. Do not add features that synthesize fake UI.
4. **No audio for now.** A free local TTS is on the roadmap; discussion welcome.
5. **Every child process must be silent.** Use the helpers (`spawnSilent`, `execFileSilentSync`, ...) in `scripts/demo-pipeline.ts`. Never call `child_process` directly, never use `shell: true`, never `detached: true` on Windows. Console windows flashing on screen is a bug.
6. **Keep timeouts on everything** that talks to an LLM or a page. A hung model must never hang the pipeline.
7. **Comments and docs in English.**

## Development notes

- When editing source programmatically, regex word-boundary escapes can silently turn into a literal backspace character (U+0008) and break the pattern. Search for that character after scripted edits.
- Playwright pads frames with grey when the device scale factor is emulated; real high-resolution capture needs the browser flag `--force-device-scale-factor` (already used).
- Parallel runs must never share intermediate files; they carry a per-process id in their names.
- Do not read or commit generated output: `out/`, `public/*`.
- For behaviour changes run the quick smoke test above and, when relevant, a full run with a local model, including auto-recovery with Ollama stopped and `--edit-scene` re-rendering.

## Pull requests

- Keep PRs focused; explain *why*, not only *what*.
- Run `npm run typecheck && npm test` before pushing.
- If you change behaviour users can see, update the README / manual and add a line to `CHANGELOG.md`.
- If you add a pure helper, add a unit test next to the others in `tests/`.

## Translations

The English README is the source of truth. Translations live in `docs/<lang>/` and may lag behind; each translation file says so at the top. If you want to maintain one, open an issue first.

## Code of conduct

Be kind and constructive. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
