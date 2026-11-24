# Changelog

All notable changes. Format loosely follows [Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/) (pre-1.0: anything may change).

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
- Example app `examples/hello-wizard`, unit tests, CI.

### Security
- Removed the experimental HTTP API server (it listened on all interfaces and ran the pipeline on request).
- API key encrypted with the OS keychain in the desktop app.
- All child processes are spawned silently and without a shell.

### Known issues
See [README, Honest status](README.md#honest-status) and [ROADMAP.md](ROADMAP.md).
