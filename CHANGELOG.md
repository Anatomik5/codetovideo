# Changelog

All notable changes. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/) (pre-1.0: anything may change).

## Unreleased

- Model comparison: Qwen 3.5 4B vs Gemma 4 E2B / E4B (`docs/benchmarks/`), and `scripts/bench-models.cjs` to compare any models on the same scenario.
- Small models are more robust: malformed plan JSON is repaired and retried once; models without a thinking mode no longer fail the background step; over-long titles and captions are cut at a word boundary.
- Export SRT and WebVTT from the desktop app or a saved session. Long captions now use shorter, proportionally timed cues in both formats (thanks Dathinel, #10).
- Unit tests for scene planning and partial-render planning; the planner's video probes can be injected in tests (thanks TONstories, #12).
- Unit tests for scene editing: scene lookup, edit-patch cleanup and the no-op filter (thanks avaldivieso-meraki, #17).
- Scene edits now cut over-long titles and captions at a word boundary, like the first plan does.

## [0.2.0] - first public release

### Added
- Desktop app (Electron): model setup, source, format, quality and background options, and a scene editor.
- Two video formats: `demo` (walkthrough with animated backdrop) and `promo` (corporate-ad look: camera moves, call-outs cropped from the real recording, kinetic captions, end card). No audio.
- Output quality 480p to 4K with a real browser-level device scale factor (genuinely sharper captures, no grey padding).
- Background modes: `auto`, `generate` (model draws), `motif` (model picks a neutral built-in motif). Animated, frame-driven backdrop.
- Non-destructive scene editing: sessions with `manifest.json` and per-scene clips; `--edit-scene`, `--edit-prompt`, `--re-render-only`; partial re-render with an `ffmpeg -c copy` splice.
- LLM health and keep-alive manager for local Ollama (auto-start, warm-up, retries, one `num_ctx`).
- Button roles (forward / back-cancel / help-toggle) decided by the connected LLM from the visible label, in any language.
- `--launch` to set the app's start command; model-proposed launch commands are restricted to known dev runtimes.
- Subtitle export: `final.srt` is written into every session after rendering, and the desktop app has an **Export subtitles (.srt)** button (initial exporter contributed by Dathinel).
- Example app `examples/hello-wizard`, unit tests (`npm run check`); a CI workflow example in `docs/ci.yml.example`.

### Security
- Removed the experimental HTTP API server (it listened on all interfaces and ran the pipeline on request).
- API key encrypted with the OS keychain in the desktop app.
- All child processes are spawned silently and without a shell.

### Known issues
See [README, Honest status](README.md#honest-status) and [ROADMAP.md](ROADMAP.md).
